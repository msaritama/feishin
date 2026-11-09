import merge from 'lodash/merge';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { useRadioStore as useRadioPlayerStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { createSelectors } from '/@/renderer/lib/zustand';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import {
    setTimestamp as setTimestampStore,
    useTimestampStoreBase,
} from '/@/renderer/store/timestamp.store';
import { migratePlayerStorePersist, playerStoreStorage } from '/@/renderer/store/utils';
import { shuffleInPlace } from '/@/renderer/utils/shuffle';
import { PlayerData, QueueData, QueueSong, Song } from '/@/shared/types/domain-types';
import {
    CrossfadeStyle,
    Play,
    PlayerRepeat,
    PlayerShuffle,
    PlayerStatus,
    PlayerStyle,
} from '/@/shared/types/types';

export interface PlayerState extends Actions, State {}

export type QueueGroupingProperty = keyof QueueSong;

interface Actions {
    addToQueueByType: (items: Song[], playType: Play, playSongId?: string) => void;
    addToQueueByUniqueId: (
        items: Song[],
        uniqueId: string,
        edge: 'bottom' | 'top',
        playSongId?: string,
        pinAboveUpNext?: boolean,
    ) => void;
    clearQueue: () => void;
    clearSelected: (items: QueueSong[]) => void;
    decreaseVolume: (value: number) => void;
    getCurrentSong: () => QueueSong | undefined;
    getPlayerData: () => PlayerData;
    getQueue: (groupBy?: QueueGroupingProperty) => GroupedQueue;
    getQueueOrder: () => GroupedQueue;
    increaseVolume: (value: number) => void;
    isFirstTrackInQueue: () => boolean;
    isLastTrackInQueue: () => boolean;
    mediaAutoNext: () => PlayerData;
    mediaNext: (toNextAlbum: boolean) => void;
    mediaPause: () => void;
    mediaPlay: (id?: string) => void;
    mediaPlayByIndex: (index: number) => void;
    mediaPrevious: (toPreviousAlbum: boolean) => void;
    mediaSeekToTimestamp: (timestamp: number) => void;
    mediaSkipBackward: (offset?: number) => void;
    mediaSkipForward: (offset?: number) => void;
    mediaStop: (options?: { reset?: boolean }) => void;
    mediaToggleMute: () => void;
    mediaTogglePlayPause: () => void;
    moveSelectedTo: (
        items: QueueSong[],
        uniqueId: string,
        edge: 'bottom' | 'top',
        pinAboveUpNext?: boolean,
    ) => void;
    moveSelectedToBottom: (items: QueueSong[]) => void;
    moveSelectedToNext: (items: QueueSong[]) => void;
    moveSelectedToTop: (items: QueueSong[]) => void;
    setCrossfadeDuration: (duration: number) => void;
    setCrossfadeStyle: (style: CrossfadeStyle) => void;
    setPauseOnNextSongEnd: (value: boolean) => void;
    setQueue: (data: Song[], index?: number, position?: number) => void;
    setRepeat: (repeat: PlayerRepeat) => void;
    setShuffle: (shuffle: PlayerShuffle) => void;
    setSpeed: (speed: number) => void;
    setTransitionType: (transitionType: PlayerStyle) => void;
    setVolume: (volume: number) => void;
    shuffle: () => void;
    shuffleAll: () => void;
    shuffleSelected: (items: QueueSong[]) => void;
    toggleRepeat: () => void;
    toggleShuffle: () => void;
}

interface GroupedQueue {
    groups: { count: number; name: string }[];
    items: QueueSong[];
}

interface State {
    hydrated: boolean;
    // Runtime-only: true once the mpv engine has finished initializing.
    // Top-level keys are not persisted (see partialize), same as `hydrated`.
    mpvInitialized: boolean;
    player: {
        crossfadeDuration: number;
        crossfadeStyle: CrossfadeStyle;
        index: number;
        muted: boolean;
        pauseOnNextSongEnd: boolean;
        playerNum: 1 | 2;
        repeat: PlayerRepeat;
        shuffle: PlayerShuffle;
        speed: number;
        status: PlayerStatus;
        transitionType: PlayerStyle;
        volume: number;
    };
    queue: QueueData;
}

// Calculates the next song based on repeat mode and current position
export function calculateNextSong(
    currentIndex: number,
    queueItems: QueueSong[],
    repeat: PlayerRepeat,
): QueueSong | undefined {
    if (queueItems.length === 0) {
        return undefined;
    }

    if (repeat === PlayerRepeat.ONE) {
        // When repeating one, next song is the same as current
        return queueItems[currentIndex];
    } else if (repeat === PlayerRepeat.ALL) {
        // When repeating all, next song wraps to first if at the end
        const isLastTrack = currentIndex === queueItems.length - 1;
        if (isLastTrack) {
            return queueItems[0];
        } else {
            return queueItems[currentIndex + 1];
        }
    } else {
        // When repeat is none, next song is undefined if at the end
        return queueItems[currentIndex + 1];
    }
}

export function getDualPlayerSongs(
    playerNum: 1 | 2,
    currentSong: QueueSong | undefined,
    nextSong: QueueSong | undefined,
    repeat: PlayerRepeat,
): { player1: QueueSong | undefined; player2: QueueSong | undefined } {
    if (repeat === PlayerRepeat.ONE) {
        return {
            player1: playerNum === 1 ? currentSong : undefined,
            player2: playerNum === 2 ? currentSong : undefined,
        };
    }

    return {
        player1: playerNum === 1 ? currentSong : nextSong,
        player2: playerNum === 2 ? currentSong : nextSong,
    };
}

// Helper function to check if shuffle is enabled
export function isShuffleEnabled(state: {
    player: { shuffle: PlayerShuffle };
    queue: { shuffled: number[] };
}): boolean {
    return state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0;
}

// Helper function to map shuffled position to actual queue position
export function mapShuffledToQueueIndex(shuffledIndex: number, shuffled: number[]): number {
    if (shuffledIndex >= 0 && shuffledIndex < shuffled.length) {
        return shuffled[shuffledIndex];
    }
    return shuffledIndex;
}

// Calculates the next index based on repeat mode and current position
function calculateNextIndex(
    currentIndex: number,
    queueLength: number,
    repeat: PlayerRepeat,
): { nextIndex: number; shouldStop: boolean } {
    const isLastTrack = currentIndex === queueLength - 1;

    if (repeat === PlayerRepeat.ONE) {
        // Repeat one: stay on the same track
        return { nextIndex: currentIndex, shouldStop: false };
    } else if (repeat === PlayerRepeat.ALL) {
        // Repeat all: loop to first track if at the end
        if (isLastTrack) {
            return { nextIndex: 0, shouldStop: false };
        } else {
            return { nextIndex: currentIndex + 1, shouldStop: false };
        }
    } else {
        // Repeat none: move to next track, or loop back and stop if at the end
        if (isLastTrack) {
            return { nextIndex: 0, shouldStop: true };
        } else {
            return { nextIndex: currentIndex + 1, shouldStop: false };
        }
    }
}

function clearActiveRadio(): void {
    const radioState = useRadioPlayerStore.getState();
    if (radioState.currentStreamUrl) {
        radioState.actions.clear();
    }
}

function emitPlayerPlayEvent(
    targetSongUniqueId: string | undefined,
    set: (fn: (state: PlayerState) => void) => void,
    get: () => PlayerState,
): void {
    // Clear radio before status changes so onPlayerStatus does not restart the stream.
    clearActiveRadio();

    // If playSongId is provided, find the song and start playback on it
    if (targetSongUniqueId) {
        let playIndex: number | undefined;
        set((state) => {
            const queue = state.getQueue();
            const queueIndex = queue.items.findIndex(
                (item) => item._uniqueId === targetSongUniqueId,
            );

            if (queueIndex !== -1) {
                if (
                    state.player.shuffle === PlayerShuffle.TRACK &&
                    state.queue.shuffled.length > 0
                ) {
                    // Find the shuffled position for this queue index
                    const shuffledPosition = state.queue.shuffled.findIndex(
                        (idx) => idx === queueIndex,
                    );
                    if (shuffledPosition !== -1) {
                        state.player.index = shuffledPosition;
                    } else {
                        state.player.index = queueIndex;
                    }
                } else {
                    state.player.index = queueIndex;
                }
                syncUpNext(state);
                playIndex = state.player.index;
                state.player.status = PlayerStatus.PLAYING;
                setTimestampStore(0);
            }
        });

        // Emit PLAYER_PLAY event if playback was started
        if (playIndex !== undefined) {
            eventEmitter.emit('PLAYER_PLAY', {
                id: targetSongUniqueId,
                index: playIndex,
            });
        }
    } else {
        // Otherwise, emit PLAYER_PLAY event for current song if available
        const currentState = get();
        const queue = currentState.getQueue();
        const currentIndex = currentState.player.index;
        const currentSong = queue.items[currentIndex];

        if (currentSong && currentIndex !== undefined && currentIndex >= 0) {
            eventEmitter.emit('PLAYER_PLAY', {
                id: currentSong._uniqueId,
                index: currentIndex,
            });
        }
    }
}

function emitPlayerStop(get: () => PlayerState, reset: boolean): void {
    const currentState = get();
    const queue = currentState.getQueue();
    const currentIndex = currentState.player.index;
    const currentSong = queue.items[currentIndex];

    eventEmitter.emit('PLAYER_STOP', {
        id: currentSong?._uniqueId,
        index: currentIndex !== undefined && currentIndex >= 0 ? currentIndex : undefined,
        reset,
    });
}

// Helper function to find shuffled position for a given queue index
function findShuffledPositionForQueueIndex(
    queueIndex: number,
    shuffled: number[],
): number | undefined {
    const shuffledPosition = shuffled.findIndex((idx) => idx === queueIndex);
    return shuffledPosition !== -1 ? shuffledPosition : undefined;
}

function restoreUnshuffledQueue(state: Pick<State, 'player' | 'queue'>): void {
    const currentIndex = state.player.index;
    const currentUniqueId =
        currentIndex >= 0 && currentIndex < state.queue.default.length
            ? state.queue.default[currentIndex]
            : undefined;

    if (state.queue.unshuffled && state.queue.unshuffled.length > 0) {
        const currentIdsSet = new Set(state.queue.default);
        const unshuffledSet = new Set(state.queue.unshuffled);

        const restored = state.queue.unshuffled.filter((id) => currentIdsSet.has(id));
        const addedWhileShuffled = state.queue.default.filter((id) => !unshuffledSet.has(id));

        state.queue.default = [...restored, ...addedWhileShuffled];
    }

    state.queue.unshuffled = [];
    state.queue.shuffled = [];

    if (currentUniqueId !== undefined) {
        const newIndex = state.queue.default.indexOf(currentUniqueId);
        if (newIndex !== -1) {
            state.player.index = newIndex;
        }
    }
}

function shuffleQueueAroundCurrent(state: Pick<State, 'player' | 'queue'>): void {
    const currentIndex = state.player.index;
    const currentUniqueId =
        currentIndex >= 0 && currentIndex < state.queue.default.length
            ? state.queue.default[currentIndex]
            : undefined;

    if (currentUniqueId !== undefined) {
        const otherItems = state.queue.default.filter((id) => id !== currentUniqueId);
        const shuffledOthers = shuffleInPlace(otherItems);

        state.queue.default = [currentUniqueId, ...shuffledOthers];
        state.player.index = 0;
    } else {
        state.queue.default = shuffleInPlace([...state.queue.default]);
    }
    state.queue.shuffled = [];
}

const isUpNextQueueEnabled = () => useSettingsStore.getState().general.upNextQueue;

const sameIds = <T>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// After songs are dragged or moved in the queue: Up Next songs moved out of the section become
// normal queue items, and moved songs dropped inside it (directly after the current song, after
// a Queue item pinned above the section, or after another Up Next song) join it.
function regroupUpNext(
    state: Pick<State, 'player' | 'queue'>,
    currentId: string | undefined,
    movedIds: string[],
): void {
    if (state.queue.priority.length === 0) return;

    const moved = new Set(movedIds);
    const kept = new Set(state.queue.priority.filter((id) => !moved.has(id)));

    // Queue items can be pinned between the current song and the Up Next block (dropped on the
    // bottom of the first Queue section). While sitting there they keep the Up Next run going,
    // so a song dropped just above the section still joins it.
    const lastKeptIndex = [...kept].reduce((last, id) => {
        const index = state.queue.default.indexOf(id);
        return index > last ? index : last;
    }, -1);

    const upNext: string[] = [];
    let previousIsUpNext = false;

    state.queue.default.forEach((id, index) => {
        if (id === currentId) {
            previousIsUpNext = true;
            return;
        }

        if (kept.has(id)) {
            previousIsUpNext = true;
            upNext.push(id);
            return;
        }

        if (moved.has(id)) {
            if (previousIsUpNext) upNext.push(id);
            return;
        }

        previousIsUpNext = previousIsUpNext && index < lastKeptIndex;
    });

    state.queue.priority = upNext;
    syncUpNext(state);
}

// True when a drop on the bottom edge of the row with `targetUniqueId` lands in the first
// Queue section, above the Up Next block (rows at or below the current song). Dropping there
// should keep the items in the Queue section instead of joining Up Next.
export const isUpNextQueueBoundaryDrop = (
    targetUniqueId: string,
    edge: 'bottom' | 'top',
): boolean => {
    if (edge !== 'bottom') return false;

    const state = usePlayerStoreBase.getState();
    const upNext = state.queue.priority;
    if (upNext.length === 0) return false;

    const upNextStart = state.queue.default.indexOf(upNext[0]);
    const rowIndex = state.queue.default.indexOf(targetUniqueId);

    if (!state.getCurrentSong()?._uniqueId) return false;

    const currentIndex =
        state.getCurrentSong() !== undefined
            ? state.queue.default.indexOf(state.getCurrentSong()!._uniqueId)
            : -1;

    return rowIndex >= currentIndex && rowIndex < upNextStart;
};

// Keeps the Up Next songs (queue.priority) as a contiguous block after the current song, in
// both the displayed order and the shuffled play order. Queue items pinned between the current
// song and the block are left in place. Songs that are playing or were removed from the queue
// leave Up Next.
function syncUpNext(state: Pick<State, 'player' | 'queue'>): void {
    const { player, queue } = state;
    if (queue.priority.length === 0) return;

    if (!isUpNextQueueEnabled()) {
        queue.priority = [];
        return;
    }

    const shuffle = isShuffleEnabled(state);
    const playOrder = shuffle ? queue.shuffled.map((i) => queue.default[i]) : queue.default;
    const currentId: string | undefined = playOrder[player.index];
    const inQueue = new Set(queue.default);
    const upNext = queue.priority.filter((id) => id !== currentId && inQueue.has(id));
    const upNextSet = new Set(upNext);

    const placeAfterCurrent = (ids: string[]) => {
        const rest = ids.filter((id) => !upNextSet.has(id));
        const at = currentId === undefined ? 0 : rest.indexOf(currentId) + 1;
        return [...rest.slice(0, at), ...upNext, ...rest.slice(at)];
    };

    // The block stays put only while it sits in front of the current song (queue items pinned
    // between them are allowed). Playing a song at or below the block settles it: the played song
    // and every queue song above it move in front of Up Next, so Up Next keeps playing next.
    const blockIsInFrontOfCurrent = (ids: string[]) => {
        if (upNext.length === 0) return false;

        const start = ids.indexOf(upNext[0]);
        if (start === -1 || !upNext.every((id, offset) => ids[start + offset] === id)) return false;

        const currentIndex = currentId === undefined ? -1 : ids.indexOf(currentId);
        return start > currentIndex;
    };
    const settle = (ids: string[]) => (blockIsInFrontOfCurrent(ids) ? ids : placeAfterCurrent(ids));

    if (!sameIds(upNext, queue.priority)) queue.priority = upNext;

    const newDefault = settle(queue.default);
    if (!sameIds(newDefault, queue.default)) queue.default = newDefault;

    if (shuffle) {
        const newPlayOrder = settle(playOrder);
        const position = new Map(queue.default.map((id, i) => [id, i]));
        const newShuffled = newPlayOrder.map((id) => position.get(id)!);
        if (!sameIds(newShuffled, queue.shuffled)) queue.shuffled = newShuffled;
        if (currentId !== undefined) player.index = newPlayOrder.indexOf(currentId);
    } else if (currentId !== undefined) {
        player.index = newDefault.indexOf(currentId);
    }
}

const initialState: State = {
    hydrated: false,
    mpvInitialized: false,
    player: {
        crossfadeDuration: 5,
        crossfadeStyle: CrossfadeStyle.EQUAL_POWER,
        index: -1,
        muted: false,
        pauseOnNextSongEnd: false,
        playerNum: 1,
        repeat: PlayerRepeat.NONE,
        shuffle: PlayerShuffle.NONE,
        speed: 1,
        status: PlayerStatus.PAUSED,
        transitionType: PlayerStyle.GAPLESS,
        volume: 30,
    },
    queue: {
        default: [],
        priority: [],
        shuffled: [],
        songs: {},
    },
};

export const usePlayerStoreBase = createWithEqualityFn<PlayerState>()(
    persist(
        subscribeWithSelector(
            immer((set, get) => ({
                addToQueueByType: (items, playType, playSongId) => {
                    const newItems = items.map(toQueueSong);
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    // Find the target song's uniqueId if playSongId is provided
                    const targetSongUniqueId = playSongId
                        ? newItems.find((item) => item.id === playSongId)?._uniqueId
                        : undefined;

                    if (
                        (playType === Play.NEXT || playType === Play.NEXT_SHUFFLE) &&
                        isUpNextQueueEnabled() &&
                        get().getCurrentSong()
                    ) {
                        set((state) => {
                            newItems.forEach((item) => {
                                state.queue.songs[item._uniqueId] = item;
                            });

                            const ids =
                                playType === Play.NEXT_SHUFFLE
                                    ? shuffleInPlace([...newUniqueIds])
                                    : newUniqueIds;

                            const lastUpNext =
                                state.queue.priority[state.queue.priority.length - 1];
                            const lastUpNextPos =
                                lastUpNext === undefined
                                    ? -1
                                    : state.queue.default.indexOf(lastUpNext);
                            const insertPos =
                                lastUpNextPos === -1 ? state.player.index + 1 : lastUpNextPos + 1;

                            state.queue.default = [
                                ...state.queue.default.slice(0, insertPos),
                                ...ids,
                                ...state.queue.default.slice(insertPos),
                            ];

                            if (
                                state.player.shuffle === PlayerShuffle.TRACK &&
                                state.queue.unshuffled
                            ) {
                                state.queue.unshuffled = [
                                    ...state.queue.unshuffled,
                                    ...newUniqueIds,
                                ];
                            }

                            state.queue.priority = [...state.queue.priority, ...ids];
                            syncUpNext(state);
                        });
                        return;
                    }

                    switch (playType) {
                        case Play.LAST: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                if (state.player.shuffle === PlayerShuffle.TRACK) {
                                    if (state.queue.unshuffled) {
                                        state.queue.unshuffled = [
                                            ...state.queue.unshuffled,
                                            ...newUniqueIds,
                                        ];
                                    }
                                    const shuffledNewIds = shuffleInPlace([...newUniqueIds]);
                                    state.queue.default = [
                                        ...state.queue.default,
                                        ...shuffledNewIds,
                                    ];
                                } else {
                                    state.queue.default = [...state.queue.default, ...newUniqueIds];
                                }
                            });
                            break;
                        }
                        case Play.LAST_SHUFFLE: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffle the new items before appending
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);

                                state.queue.default = [...state.queue.default, ...shuffledIds];

                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.unshuffled
                                ) {
                                    state.queue.unshuffled = [
                                        ...state.queue.unshuffled,
                                        ...newUniqueIds,
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.NEXT: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                const insertPosition = state.player.index + 1;

                                state.queue.default = [
                                    ...state.queue.default.slice(0, insertPosition),
                                    ...newUniqueIds,
                                    ...state.queue.default.slice(insertPosition),
                                ];

                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.unshuffled
                                ) {
                                    state.queue.unshuffled = [
                                        ...state.queue.unshuffled,
                                        ...newUniqueIds,
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.NEXT_SHUFFLE: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffle the new items before inserting
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);

                                const insertPosition = state.player.index + 1;

                                state.queue.default = [
                                    ...state.queue.default.slice(0, insertPosition),
                                    ...shuffledIds,
                                    ...state.queue.default.slice(insertPosition),
                                ];

                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.unshuffled
                                ) {
                                    state.queue.unshuffled = [
                                        ...state.queue.unshuffled,
                                        ...newUniqueIds,
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.NOW: {
                            clearActiveRadio();

                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                state.player.index = 0;
                                state.player.status = PlayerStatus.PLAYING;
                                state.player.playerNum = 1;
                                setTimestampStore(0);
                                state.queue.shuffled = [];

                                if (state.player.shuffle === PlayerShuffle.TRACK) {
                                    state.queue.unshuffled = [
                                        ...newUniqueIds,
                                        ...state.queue.priority,
                                    ];

                                    if (targetSongUniqueId) {
                                        const initialIndex = newUniqueIds.findIndex(
                                            (id) => id === targetSongUniqueId,
                                        );
                                        if (initialIndex !== -1) {
                                            const otherIds = newUniqueIds.filter(
                                                (id) => id !== targetSongUniqueId,
                                            );
                                            const shuffledOthers = shuffleInPlace([...otherIds]);

                                            state.queue.default = [
                                                targetSongUniqueId,
                                                ...shuffledOthers,
                                                ...state.queue.priority,
                                            ];
                                            state.player.index = 0;
                                        } else {
                                            const shuffledIds = shuffleInPlace([...newUniqueIds]);
                                            state.queue.default = [
                                                ...shuffledIds,
                                                ...state.queue.priority,
                                            ];
                                        }
                                    } else {
                                        const shuffledIds = shuffleInPlace([...newUniqueIds]);
                                        state.queue.default = [
                                            ...shuffledIds,
                                            ...state.queue.priority,
                                        ];
                                    }
                                } else {
                                    state.queue.unshuffled = [];
                                    // Up Next carries over to the new queue
                                    state.queue.default = [
                                        ...newUniqueIds,
                                        ...state.queue.priority,
                                    ];
                                }

                                syncUpNext(state);
                            });

                            emitPlayerPlayEvent(targetSongUniqueId, set, get);
                            break;
                        }
                        case Play.SHUFFLE: {
                            clearActiveRadio();

                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                let shuffledIds: string[];
                                if (
                                    targetSongUniqueId &&
                                    newUniqueIds.includes(targetSongUniqueId)
                                ) {
                                    const otherIds = newUniqueIds.filter(
                                        (id) => id !== targetSongUniqueId,
                                    );
                                    shuffledIds = [
                                        targetSongUniqueId,
                                        ...shuffleInPlace([...otherIds]),
                                    ];
                                } else {
                                    shuffledIds = shuffleInPlace([...newUniqueIds]);
                                }

                                state.player.index = 0;
                                state.player.status = PlayerStatus.PLAYING;
                                state.player.playerNum = 1;
                                state.player.shuffle = PlayerShuffle.TRACK;
                                setTimestampStore(0);
                                state.queue.shuffled = [];
                                state.queue.unshuffled = [...newUniqueIds, ...state.queue.priority];
                                // Up Next carries over to the new queue
                                state.queue.default = [...shuffledIds, ...state.queue.priority];

                                syncUpNext(state);
                            });

                            emitPlayerPlayEvent(targetSongUniqueId, set, get);
                            break;
                        }
                    }
                },
                addToQueueByUniqueId: (items, uniqueId, edge, playSongId, pinAboveUpNext) => {
                    const newItems = items.map(toQueueSong);
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    // Find the target song's uniqueId if playSongId is provided
                    const targetSongUniqueId = playSongId
                        ? newItems.find((item) => item.id === playSongId)?._uniqueId
                        : undefined;
                    const currentSongUniqueId = get().getCurrentSong()?._uniqueId;

                    set((state) => {
                        // Add new songs to songs object
                        newItems.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const index = state.queue.default.findIndex((id) => id === uniqueId);

                        const insertIndex = Math.max(0, edge === 'top' ? index : index + 1);

                        const newQueue = [
                            ...state.queue.default.slice(0, insertIndex),
                            ...newUniqueIds,
                            ...state.queue.default.slice(insertIndex),
                        ];

                        state.queue.default = newQueue;

                        if (
                            state.player.shuffle === PlayerShuffle.TRACK &&
                            state.queue.unshuffled
                        ) {
                            state.queue.unshuffled = [...state.queue.unshuffled, ...newUniqueIds];
                        }

                        // Recalculate the player index if we're inserting items above the current index
                        if (insertIndex <= state.player.index) {
                            state.player.index = state.player.index + newUniqueIds.length;
                        }

                        recalculatePlayerIndex(state, newQueue);

                        regroupUpNext(state, currentSongUniqueId, newUniqueIds);

                        // Dropping on the bottom edge of the last row of the first Queue section keeps
                        // the new songs in Queue, so they must not be pulled into the Up Next block.
                        if (pinAboveUpNext) {
                            state.queue.priority = state.queue.priority.filter(
                                (id) => !newUniqueIds.includes(id),
                            );
                        }
                    });

                    // If playSongId is provided, find the song and start playback on it
                    if (targetSongUniqueId) {
                        clearActiveRadio();

                        let playIndex: number | undefined;
                        set((state) => {
                            const queue = state.getQueue();
                            const queueIndex = queue.items.findIndex(
                                (item) => item._uniqueId === targetSongUniqueId,
                            );

                            if (queueIndex !== -1) {
                                state.player.index = queueIndex;
                                syncUpNext(state);
                                playIndex = state.player.index;
                                state.player.status = PlayerStatus.PLAYING;
                                setTimestampStore(0);
                            }
                        });

                        // Emit PLAYER_PLAY event if playback was started
                        if (playIndex !== undefined) {
                            eventEmitter.emit('PLAYER_PLAY', {
                                id: targetSongUniqueId,
                                index: playIndex,
                            });
                        }
                    }
                },
                clearQueue: () => {
                    set((state) => {
                        state.player.index = -1;
                        state.queue.default = [];
                        state.queue.priority = [];
                        state.queue.shuffled = [];
                        state.queue.unshuffled = [];
                        state.queue.songs = {};
                    });
                },
                clearSelected: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = new Set(items.map((item) => item._uniqueId));

                        state.queue.default = state.queue.default.filter(
                            (id) => !uniqueIds.has(id),
                        );
                        if (state.queue.unshuffled && state.queue.unshuffled.length > 0) {
                            state.queue.unshuffled = state.queue.unshuffled.filter(
                                (id) => !uniqueIds.has(id),
                            );
                        }
                        state.queue.shuffled = [];

                        cleanupOrphanedSongs(state);

                        recalculatePlayerIndex(state, state.queue.default);
                        syncUpNext(state);
                    });
                },
                decreaseVolume: (value: number) => {
                    set((state) => {
                        state.player.volume = Math.max(0, state.player.volume - value);
                    });
                },
                getCurrentSong: () => {
                    const state = get();
                    const queue = state.getQueue();
                    let index = state.player.index;

                    // If shuffle is enabled, map shuffled position to actual queue position
                    if (isShuffleEnabled(state)) {
                        index = mapShuffledToQueueIndex(index, state.queue.shuffled);
                    }

                    return queue.items[index];
                },
                getPlayerData: () => {
                    const state = get();
                    const queue = state.getQueue();
                    const index = state.player.index;

                    // If shuffle is enabled, map shuffled position to actual queue position for display
                    let queueIndex = index;
                    if (isShuffleEnabled(state)) {
                        queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
                    }

                    const currentSong = queue.items[queueIndex];
                    const repeat = state.player.repeat;

                    // For previousSong calculation, we need to consider the shuffled order
                    let previousSong: QueueSong | undefined;
                    if (isShuffleEnabled(state)) {
                        // Calculate previous in shuffled order
                        const previousShuffledIndex = index - 1;
                        if (previousShuffledIndex >= 0) {
                            const previousQueueIndex = state.queue.shuffled[previousShuffledIndex];
                            previousSong = queue.items[previousQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            // Wrap to last in shuffled order
                            const lastShuffledIndex = state.queue.shuffled.length - 1;
                            const lastQueueIndex = state.queue.shuffled[lastShuffledIndex];
                            previousSong = queue.items[lastQueueIndex];
                        }
                    } else {
                        previousSong = queueIndex > 0 ? queue.items[queueIndex - 1] : undefined;
                    }

                    // For nextSong calculation, we need to consider the shuffled order
                    let nextSong: QueueSong | undefined;
                    if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                        // Calculate next in shuffled order
                        const nextShuffledIndex = index + 1;
                        if (nextShuffledIndex < state.queue.shuffled.length) {
                            const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                            nextSong = queue.items[nextQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            // Wrap to first in shuffled order
                            const firstQueueIndex = state.queue.shuffled[0];
                            nextSong = queue.items[firstQueueIndex];
                        }
                    } else {
                        nextSong = calculateNextSong(queueIndex, queue.items, repeat);
                    }

                    const { player1, player2 } = getDualPlayerSongs(
                        state.player.playerNum,
                        currentSong,
                        nextSong,
                        repeat,
                    );

                    return {
                        currentSong,
                        index: queueIndex, // Return the actual queue position for display
                        nextSong,
                        num: state.player.playerNum,
                        player1,
                        player2,
                        previousSong,
                        queueLength: state.queue.default.length,
                        status: state.player.status,
                    };
                },
                getQueue: (groupBy?: QueueGroupingProperty) => {
                    const queue = get().getQueueOrder();

                    if (!groupBy) {
                        return queue;
                    }

                    // Track groups in order of appearance
                    const groups: { count: number; name: string }[] = [];
                    const seenGroups = new Set<string>();

                    // Process items and build groups in order
                    queue.items.forEach((item) => {
                        const groupValue = String(item[groupBy] || 'Unknown');

                        if (!seenGroups.has(groupValue)) {
                            seenGroups.add(groupValue);
                            groups.push({ count: 1, name: groupValue });
                        } else {
                            // Find the last occurrence of this group value
                            const lastIndex = [...groups]
                                .reverse()
                                .findIndex((g) => g.name === groupValue);
                            if (lastIndex === -1) return;

                            // If the previous group is different, create a new group
                            const previousGroup = groups[groups.length - 1];
                            if (previousGroup.name !== groupValue) {
                                groups.push({ count: 1, name: groupValue });
                            } else {
                                // Increment the count of the last matching group
                                groups[groups.length - 1].count++;
                            }
                        }
                    });

                    return { groups, items: queue.items };
                },
                getQueueOrder: () => {
                    const state = get();
                    const songs = state.queue.songs;
                    const defaultIds = state.queue.default;
                    const defaultQueue: QueueSong[] = [];

                    for (const id of defaultIds) {
                        const song = songs[id];
                        if (song) defaultQueue.push(song);
                    }

                    // Always return original order (shuffle only affects playback, not display)
                    return {
                        groups: [{ count: defaultQueue.length, name: 'All' }],
                        items: defaultQueue,
                    };
                },
                increaseVolume: (value: number) => {
                    set((state) => {
                        state.player.volume = Math.min(100, state.player.volume + value);
                    });
                },
                isFirstTrackInQueue: () => {
                    const state = get();
                    const currentIndex = state.player.index;
                    return currentIndex === 0;
                },
                isLastTrackInQueue: () => {
                    const state = get();
                    const queue = state.getQueueOrder();
                    const currentIndex = state.player.index;
                    return currentIndex === queue.items.length - 1;
                },
                mediaAutoNext: () => {
                    const stateSnapshot = get();
                    const currentIndex = stateSnapshot.player.index;
                    const player = stateSnapshot.player;
                    const repeat = player.repeat;
                    const queue = stateSnapshot.getQueueOrder();
                    const isShuffle = isShuffleEnabled(stateSnapshot);

                    const playbackLength = isShuffle
                        ? stateSnapshot.queue.shuffled.length
                        : queue.items.length;

                    const { nextIndex: nextPlaybackIndex, shouldStop } = calculateNextIndex(
                        currentIndex,
                        playbackLength,
                        repeat,
                    );

                    const isRepeatOneSameTrack =
                        repeat === PlayerRepeat.ONE && nextPlaybackIndex === currentIndex;
                    // Dual web players alternate for gapless/crossfade between tracks. Repeat-one
                    // replays the same track — keep playerNum so Chromium stays bound to the same
                    // <audio> element and hardware media keys keep working.
                    const newPlayerNum = isRepeatOneSameTrack
                        ? player.playerNum
                        : player.playerNum === 1
                          ? 2
                          : 1;
                    const pauseOnNext = player.pauseOnNextSongEnd;
                    const newStatus = shouldStop
                        ? PlayerStatus.STOPPED
                        : pauseOnNext
                          ? PlayerStatus.PAUSED
                          : PlayerStatus.PLAYING;
                    const shouldKeepCurrentPlayer = newStatus !== PlayerStatus.PLAYING;
                    const shouldSwapPlayer = !isRepeatOneSameTrack && !shouldKeepCurrentPlayer;

                    set((state) => {
                        state.player.index = nextPlaybackIndex;
                        state.player.playerNum = shouldSwapPlayer ? newPlayerNum : player.playerNum;
                        setTimestampStore(0);
                        state.player.status = newStatus;

                        if (pauseOnNext) {
                            state.player.pauseOnNextSongEnd = false;
                        }

                        syncUpNext(state);
                    });

                    if (shouldStop) {
                        eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp: 0 });
                        emitPlayerStop(get, true);
                    }

                    if (repeat === PlayerRepeat.ONE && nextPlaybackIndex === currentIndex) {
                        eventEmitter.emit('PLAYER_REPEATED', {
                            index: nextPlaybackIndex,
                        });
                    }

                    // Compute current/next/previous using the same shuffle-aware mapping as getPlayerData().
                    let currentQueueIndex = nextPlaybackIndex;
                    if (isShuffle) {
                        currentQueueIndex = mapShuffledToQueueIndex(
                            nextPlaybackIndex,
                            stateSnapshot.queue.shuffled,
                        );
                    }

                    const currentSong = queue.items[currentQueueIndex];

                    let nextSong: QueueSong | undefined;
                    if (isShuffle && repeat !== PlayerRepeat.ONE) {
                        const nextShuffledIndex = nextPlaybackIndex + 1;
                        if (nextShuffledIndex < stateSnapshot.queue.shuffled.length) {
                            const nextQueueIndex = stateSnapshot.queue.shuffled[nextShuffledIndex];
                            nextSong = queue.items[nextQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            const firstQueueIndex = stateSnapshot.queue.shuffled[0];
                            nextSong = queue.items[firstQueueIndex];
                        }
                    } else {
                        nextSong = calculateNextSong(currentQueueIndex, queue.items, repeat);
                    }

                    let previousSong: QueueSong | undefined;
                    if (isShuffle) {
                        const prevShuffledIndex = nextPlaybackIndex - 1;
                        if (prevShuffledIndex >= 0) {
                            const prevQueueIndex = stateSnapshot.queue.shuffled[prevShuffledIndex];
                            previousSong = queue.items[prevQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            const lastShuffledIndex = stateSnapshot.queue.shuffled.length - 1;
                            const lastQueueIndex = stateSnapshot.queue.shuffled[lastShuffledIndex];
                            previousSong = queue.items[lastQueueIndex];
                        }
                    } else {
                        previousSong =
                            currentQueueIndex > 0 ? queue.items[currentQueueIndex - 1] : undefined;
                    }

                    const { player1, player2 } = getDualPlayerSongs(
                        shouldSwapPlayer ? newPlayerNum : player.playerNum,
                        currentSong,
                        nextSong,
                        repeat,
                    );

                    return {
                        currentSong,
                        index: currentQueueIndex,
                        nextSong,
                        num: shouldSwapPlayer ? newPlayerNum : player.playerNum,
                        player1,
                        player2,
                        previousSong,
                        queueLength: queue.items.length,
                        status: newStatus,
                    };
                },
                mediaNext: (toNextAlbum) => {
                    const state = get();
                    const currentIndex = state.player.index;
                    const player = state.player;
                    const repeat = player.repeat;
                    const isShuffle = isShuffleEnabled(state);
                    const queue = state.getQueueOrder();
                    const playbackLength = isShuffle
                        ? state.queue.shuffled.length
                        : queue.items.length;

                    const isStopped = state.player.status === PlayerStatus.STOPPED;

                    if (repeat === PlayerRepeat.ONE) {
                        // Manual next while repeat-one is active should still advance in the queue.
                        const nextIndex = Math.min(playbackLength - 1, currentIndex + 1);

                        set((state) => {
                            state.player.index = nextIndex;
                            state.player.playerNum = 1;
                            setTimestampStore(0);

                            if (isStopped) {
                                state.player.status = PlayerStatus.PLAYING;
                            }

                            syncUpNext(state);
                        });

                        eventEmitter.emit('MEDIA_NEXT', {
                            currentIndex,
                            nextIndex: get().player.index,
                        });
                        return;
                    }

                    const nextIndexProps = calculateNextIndex(currentIndex, playbackLength, repeat);
                    let { nextIndex } = nextIndexProps;
                    const { shouldStop } = nextIndexProps;

                    if (toNextAlbum && !shouldStop) {
                        const currentItem = queue.items[currentIndex];
                        const [start, end] = findLastAlbumRange(queue.items);
                        const isOnLastAlbum = start <= currentIndex && currentIndex <= end;
                        if (isOnLastAlbum) {
                            const nextIndexWithNextAlbum = queue.items.findIndex(
                                (i) => i.albumId !== currentItem.albumId,
                            );

                            nextIndex = Math.max(0, nextIndexWithNextAlbum);
                        } else {
                            const queueStartingFromCurrent = queue.items.slice(currentIndex);
                            const nextIndexWithNextAlbum = queueStartingFromCurrent.findIndex(
                                (i) => i.albumId !== currentItem.albumId,
                            );
                            nextIndex =
                                nextIndexWithNextAlbum +
                                (queue.items.length - queueStartingFromCurrent.length);
                        }
                    }

                    if (shouldStop) {
                        set((state) => {
                            state.player.index = nextIndex;
                            state.player.status = PlayerStatus.STOPPED;
                            state.player.playerNum = 1;
                            setTimestampStore(0);
                        });
                        eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp: 0 });
                        emitPlayerStop(get, true);
                        return;
                    }

                    set((state) => {
                        state.player.index = nextIndex;
                        state.player.playerNum = 1;
                        setTimestampStore(0);

                        if (isStopped) {
                            state.player.status = PlayerStatus.PLAYING;
                        }

                        syncUpNext(state);
                    });

                    eventEmitter.emit('MEDIA_NEXT', {
                        currentIndex,
                        nextIndex: get().player.index,
                    });
                },
                mediaPause: () => {
                    set((state) => {
                        state.player.status = PlayerStatus.PAUSED;
                    });
                },
                mediaPlay: (id?: string) => {
                    let playIndex: number | undefined;

                    // Playing a specific queue song should dismiss radio first.
                    if (id) {
                        clearActiveRadio();
                    }

                    set((state) => {
                        if (id) {
                            const queue = state.getQueue();

                            // Find the song in the original queue
                            const queueIndex = queue.items.findIndex(
                                (item) => item._uniqueId === id,
                            );

                            if (queueIndex !== -1) {
                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.shuffled.length > 0
                                ) {
                                    // Find the shuffled position for this queue index
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                    } else {
                                        state.player.index = queueIndex;
                                    }
                                } else {
                                    state.player.index = queueIndex;
                                }
                                syncUpNext(state);
                                playIndex = state.player.index;
                                setTimestampStore(0);
                            }
                        }

                        state.player.status = PlayerStatus.PLAYING;
                    });

                    if (id && playIndex !== undefined) {
                        eventEmitter.emit('PLAYER_PLAY', {
                            id,
                            index: playIndex,
                        });
                    }
                },
                mediaPlayByIndex: (index: number) => {
                    let playIndex: number | undefined;
                    let songId: string | undefined;

                    clearActiveRadio();

                    set((state) => {
                        const queue = state.getQueue();

                        if (index === -1 || index >= queue.items.length) {
                            state.player.status = PlayerStatus.PAUSED;
                            return;
                        }

                        // Get the song's unique ID from the queue
                        const song = queue.items[index];
                        if (song) {
                            songId = song._uniqueId;
                        }

                        // index is the position in the original queue
                        if (isShuffleEnabled(state)) {
                            // Find the shuffled position for this queue index
                            const shuffledPosition = findShuffledPositionForQueueIndex(
                                index,
                                state.queue.shuffled,
                            );
                            state.player.index =
                                shuffledPosition !== undefined ? shuffledPosition : index;
                        } else {
                            state.player.index = index;
                        }
                        syncUpNext(state);
                        playIndex = state.player.index;
                        setTimestampStore(0);

                        state.player.status = PlayerStatus.PLAYING;
                    });

                    if (songId && playIndex !== undefined) {
                        eventEmitter.emit('PLAYER_PLAY', {
                            id: songId,
                            index: playIndex,
                        });
                    }
                },
                mediaPrevious: (toPreviousAlbum) => {
                    const currentIndex = get().player.index;
                    const player = get().player;
                    const queue = get().getQueueOrder();
                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const isFirstTrack = currentIndex === 0;

                    // If timestamp is greater than 10 seconds, restart current song
                    if (currentTimestamp > 10) {
                        eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp: 0 });
                        return;
                    }

                    let previousIndex: number;

                    if (player.repeat === PlayerRepeat.ALL && isFirstTrack) {
                        // Repeat all: wrap to last track when on first track
                        previousIndex = queue.items.length - 1;
                    } else if (player.repeat === PlayerRepeat.NONE && isFirstTrack) {
                        // Repeat none: stay on first track if already there
                        previousIndex = currentIndex;
                    } else if (toPreviousAlbum) {
                        previousIndex = Math.max(
                            0,
                            findIndexWithPreviousAlbum(queue.items, currentIndex),
                        );
                    } else {
                        // Otherwise, go to previous track
                        previousIndex = Math.max(0, currentIndex - 1);
                    }

                    // Same Chromium Media Session pitfall as mediaNext: a STOPPED→new-src
                    // transition without PLAYING drops OS media-key routing.
                    const resumeFromStopped = get().player.status === PlayerStatus.STOPPED;

                    set((state) => {
                        state.player.index = previousIndex;
                        state.player.playerNum = 1;
                        setTimestampStore(0);
                        if (resumeFromStopped) {
                            state.player.status = PlayerStatus.PLAYING;
                        }

                        syncUpNext(state);
                    });

                    eventEmitter.emit('MEDIA_PREV', {
                        currentIndex,
                        prevIndex: get().player.index,
                    });
                },
                mediaSeekToTimestamp: (timestamp: number) => {
                    // See mediaSkipBackward: update the timestamp store right away to
                    // avoid the stale-read left by the ~500ms engine poll.
                    setTimestampStore(timestamp);
                    eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp });
                },
                mediaSkipBackward: (offset?: number) => {
                    const offsetFromSettings =
                        useSettingsStore.getState().general.skipButtons.skipBackwardSeconds;
                    const timeToSkip = offset ?? offsetFromSettings ?? 5;
                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const newTimestamp = Math.max(0, currentTimestamp - timeToSkip);

                    // Update the timestamp store right away so the UI and any
                    // subsequent seek compute from the new position instead of the
                    // stale value left by the ~500ms engine poll (otherwise mashing
                    // the seek keys repeatedly lands on the same time).
                    setTimestampStore(newTimestamp);
                    eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp: newTimestamp });
                },
                mediaSkipForward: (offset?: number) => {
                    const state = get();
                    const queue = state.getQueue();
                    const index = state.player.index;
                    const currentTrack = queue.items[index];
                    const duration = currentTrack?.duration;
                    const offsetFromSettings =
                        useSettingsStore.getState().general.skipButtons.skipForwardSeconds;
                    const timeToSkip = offset ?? offsetFromSettings ?? 5;

                    if (!duration) {
                        return;
                    }

                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const newTimestamp = Math.min(
                        duration / 1000 - 1,
                        currentTimestamp + timeToSkip,
                    );

                    // See mediaSkipBackward: update the timestamp store right away to
                    // avoid the stale-read left by the ~500ms engine poll.
                    setTimestampStore(newTimestamp);
                    eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp: newTimestamp });
                },
                mediaStop: (options?: { reset?: boolean }) => {
                    const reset = options?.reset !== false;
                    set((state) => {
                        state.player.status = PlayerStatus.STOPPED;
                        if (reset) {
                            setTimestampStore(0);
                        }
                    });

                    if (reset) {
                        eventEmitter.emit('PLAYER_SEEK_TO_TIMESTAMP', { timestamp: 0 });
                    }

                    emitPlayerStop(get, reset);
                },
                mediaToggleMute: () => {
                    set((state) => {
                        state.player.muted = !state.player.muted;
                    });
                },
                mediaTogglePlayPause: () => {
                    // Restarting from STOPPED (e.g. end of queue) needs a full play
                    // event so engines like mpv can reload the current track — play()
                    // alone is a no-op when mpv's playlist-pos is -1.
                    const wasStopped = get().player.status === PlayerStatus.STOPPED;

                    set((state) => {
                        if (state.player.status === PlayerStatus.PLAYING) {
                            state.player.status = PlayerStatus.PAUSED;
                        } else {
                            state.player.status = PlayerStatus.PLAYING;
                        }
                    });

                    if (wasStopped) {
                        emitPlayerPlayEvent(undefined, set, get);
                    }
                },
                moveSelectedTo: (
                    items: QueueSong[],
                    uniqueId: string,
                    edge: 'bottom' | 'top',
                    pinAboveUpNext = false,
                ) => {
                    const itemUniqueIds = items.map((item) => item._uniqueId);

                    set((state) => {
                        const currentId = get().getCurrentSong()?._uniqueId;

                        // Find the index of the drop target
                        const index = state.queue.default.findIndex((id) => id === uniqueId);

                        // Get the new index based on the edge
                        const insertIndex = Math.max(0, edge === 'top' ? index : index + 1);

                        const existingIds = new Set(Object.keys(state.queue.songs));

                        // Add new songs to songs object (avoiding duplicates)
                        items.forEach((item) => {
                            if (!existingIds.has(item._uniqueId)) {
                                state.queue.songs[item._uniqueId] = item;
                            }
                        });

                        const idsBefore = state.queue.default
                            .slice(0, insertIndex)
                            .filter((id) => !itemUniqueIds.includes(id));

                        const idsAfter = state.queue.default
                            .slice(insertIndex)
                            .filter((id) => !itemUniqueIds.includes(id));

                        const newQueue = [...idsBefore, ...itemUniqueIds, ...idsAfter];

                        recalculatePlayerIndex(state, newQueue);
                        state.queue.default = newQueue;
                        regroupUpNext(state, currentId, itemUniqueIds);

                        if (pinAboveUpNext) {
                            state.queue.priority = state.queue.priority.filter(
                                (id) => !itemUniqueIds.includes(id),
                            );
                        }
                    });
                },
                moveSelectedToBottom: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const filtered = state.queue.default.filter(
                            (id) => !uniqueIds.includes(id),
                        );

                        const newQueue = [...filtered, ...uniqueIds];

                        recalculatePlayerIndex(state, newQueue);

                        state.queue.default = newQueue;
                        regroupUpNext(state, get().getCurrentSong()?._uniqueId, uniqueIds);
                    });
                },
                moveSelectedToNext: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const currentIndex = state.player.index;
                        let beforeCurrent = 0;
                        const filtered = state.queue.default.filter((id, idx) => {
                            const shouldMove = uniqueIds.includes(id);
                            if (shouldMove && idx < currentIndex) {
                                beforeCurrent++;
                            }

                            return !shouldMove;
                        });

                        // For every item that is before the current item, subtract one as
                        // these items will shift the queue up. When Queue items are pinned
                        // above the Up Next block, insert at the top of the block instead so
                        // the new songs stay inside the section's displayed span.
                        const upNextFirst = state.queue.priority[0];
                        const upNextTop =
                            upNextFirst !== undefined ? filtered.indexOf(upNextFirst) : -1;
                        const insertIndex =
                            upNextTop !== -1 ? upNextTop : currentIndex + 1 - beforeCurrent;

                        const newQueue = [
                            ...filtered.slice(0, insertIndex),
                            ...uniqueIds,
                            ...filtered.slice(insertIndex),
                        ];

                        recalculatePlayerIndex(state, newQueue);
                        state.queue.default = newQueue;
                        regroupUpNext(state, get().getCurrentSong()?._uniqueId, uniqueIds);
                    });
                },
                moveSelectedToTop: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const filtered = state.queue.default.filter(
                            (id) => !uniqueIds.includes(id),
                        );

                        const newQueue = [...uniqueIds, ...filtered];

                        recalculatePlayerIndex(state, newQueue);

                        state.queue.default = newQueue;
                        regroupUpNext(state, get().getCurrentSong()?._uniqueId, uniqueIds);
                    });
                },
                setQueue: (items, index, position) => {
                    const newItems = items.map(toQueueSong);
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    set((state) => {
                        newItems.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        state.player.index = index ?? 0;
                        state.player.status = PlayerStatus.PLAYING;
                        state.player.playerNum = 1;
                        state.queue.default = newUniqueIds;
                        state.queue.shuffled = [];
                        state.queue.unshuffled =
                            state.player.shuffle === PlayerShuffle.TRACK ? [...newUniqueIds] : [];
                        syncUpNext(state);
                    });

                    eventEmitter.emit('QUEUE_RESTORED', {
                        data: items,
                        index: index ?? 0,
                        position: position ?? 0,
                    });
                },
                ...initialState,
                setCrossfadeDuration: (duration: number) => {
                    set((state) => {
                        const normalizedDuration = Math.max(3, Math.min(21, duration));
                        state.player.crossfadeDuration = normalizedDuration;
                    });
                },
                setCrossfadeStyle: (style: CrossfadeStyle) => {
                    set((state) => {
                        state.player.crossfadeStyle = style;
                    });
                },
                setPauseOnNextSongEnd: (value: boolean) => {
                    set((state) => {
                        state.player.pauseOnNextSongEnd = value;
                    });
                },
                setRepeat: (repeat: PlayerRepeat) => {
                    set((state) => {
                        state.player.repeat = repeat;
                    });
                },
                setShuffle: (shuffle: PlayerShuffle) => {
                    set((state) => {
                        const wasShuffled = state.player.shuffle === PlayerShuffle.TRACK;
                        const willBeShuffled = shuffle === PlayerShuffle.TRACK;

                        state.player.shuffle = shuffle;

                        if (willBeShuffled) {
                            if (!wasShuffled || !state.queue.unshuffled?.length) {
                                state.queue.unshuffled = [...state.queue.default];
                            }
                            shuffleQueueAroundCurrent(state);
                        } else if (wasShuffled) {
                            restoreUnshuffledQueue(state);
                        }
                        cleanupOrphanedSongs(state);
                        syncUpNext(state);
                    });
                },
                setSpeed: (speed: number) => {
                    set((state) => {
                        const normalizedSpeed = Math.max(0.5, Math.min(2, speed));
                        state.player.speed = normalizedSpeed;
                    });
                },
                setTransitionType: (transitionType: PlayerStyle) => {
                    set((state) => {
                        state.player.transitionType = transitionType;
                    });
                },
                setVolume: (volume: number) => {
                    set((state) => {
                        state.player.volume = Math.min(100, Math.max(0, volume));
                    });
                },
                shuffle: () => {
                    set((state) => {
                        if (state.player.shuffle === PlayerShuffle.TRACK) {
                            shuffleQueueAroundCurrent(state);
                        }
                        syncUpNext(state);
                    });
                },
                shuffleAll: () => {
                    set((state) => {
                        if (state.player.shuffle !== PlayerShuffle.TRACK) {
                            state.player.shuffle = PlayerShuffle.TRACK;
                            state.queue.unshuffled = [...state.queue.default];
                        } else if (!state.queue.unshuffled?.length) {
                            state.queue.unshuffled = [...state.queue.default];
                        }

                        shuffleQueueAroundCurrent(state);
                        syncUpNext(state);
                    });
                },
                shuffleSelected: (items: QueueSong[]) => {
                    set((state) => {
                        const itemUniqueIds = items.map((item) => item._uniqueId);

                        // Find positions of selected items in the default queue
                        const selectedPositions = itemUniqueIds
                            .map((id) => state.queue.default.findIndex((i) => i === id))
                            .filter((idx) => idx !== -1)
                            .sort((a, b) => a - b); // Sort to maintain order

                        if (selectedPositions.length === 0) {
                            return;
                        }

                        // Get the selected items in their current order
                        const selectedItems = selectedPositions.map(
                            (pos) => state.queue.default[pos],
                        );

                        // Shuffle the selected items
                        const shuffledItems = shuffleInPlace([...selectedItems]);

                        // Rebuild the default queue with shuffled selected items
                        const newDefaultQueue = [...state.queue.default];
                        selectedPositions.forEach((pos, i) => {
                            newDefaultQueue[pos] = shuffledItems[i];
                        });

                        state.queue.default = newDefaultQueue;
                        state.queue.shuffled = [];
                        recalculatePlayerIndex(state, state.queue.default);
                        syncUpNext(state);
                    });
                },
                toggleRepeat: () => {
                    set((state) => {
                        if (state.player.repeat === PlayerRepeat.NONE) {
                            state.player.repeat = PlayerRepeat.ONE;
                        } else if (state.player.repeat === PlayerRepeat.ONE) {
                            state.player.repeat = PlayerRepeat.ALL;
                        } else {
                            state.player.repeat = PlayerRepeat.NONE;
                        }
                    });
                },
                toggleShuffle: () => {
                    set((state) => {
                        const willBeShuffled = state.player.shuffle !== PlayerShuffle.TRACK;

                        state.player.shuffle = willBeShuffled
                            ? PlayerShuffle.TRACK
                            : PlayerShuffle.NONE;

                        if (willBeShuffled) {
                            state.queue.unshuffled = [...state.queue.default];
                            shuffleQueueAroundCurrent(state);
                        } else {
                            restoreUnshuffledQueue(state);
                        }
                        syncUpNext(state);
                    });
                },
            })),
        ),
        {
            merge: (persistedState: any, currentState: any) => {
                const merged = merge(currentState, persistedState);

                if (merged.player) {
                    merged.player.volume = Math.min(100, Math.max(0, merged.player.volume));
                }

                return merged;
            },
            migrate: async (persistedState, oldVersion) => {
                if (oldVersion < 3) {
                    return {} as PlayerState;
                }

                if (oldVersion === 3) {
                    await migratePlayerStorePersist('player-store');
                    return persistedState as Partial<PlayerState>;
                }

                return persistedState as Partial<PlayerState>;
            },
            name: 'player-store',
            onRehydrateStorage: () => (state) => {
                if (!state) return;
                const playback = useSettingsStore.getState().playback;
                if (playback.previousLocalVolume !== undefined) {
                    state.player.volume = Math.min(100, Math.max(0, playback.previousLocalVolume));
                }
                if (
                    state.player?.shuffle === PlayerShuffle.TRACK &&
                    state.queue?.shuffled &&
                    state.queue.shuffled.length > 0
                ) {
                    state.queue.unshuffled = [...state.queue.default];
                    const currentShuffledIdx = state.player.index;
                    state.queue.default = state.queue.shuffled
                        .map((idx) => state.queue.default[idx])
                        .filter((id): id is string => id !== undefined);
                    state.queue.shuffled = [];
                    if (
                        currentShuffledIdx >= 0 &&
                        currentShuffledIdx < state.queue.default.length
                    ) {
                        state.player.index = currentShuffledIdx;
                    }
                }
                usePlayerStoreBase.setState({ hydrated: true });
            },
            partialize: (state) => {
                const shouldRestorePlayQueue = useSettingsStore.getState().general.resume;

                // Exclude playerNum and status from stored player object
                // These are not needed to be stored since they are ephemeral properties
                // Note: timestamp is now in a separate store and doesn't need to be excluded here
                const excludedPlayerKeys = ['playerNum', 'status'];

                // If we're not restoring the play queue, we don't need the index property
                // (it is meaningless without the queue)
                if (!shouldRestorePlayQueue) {
                    excludedPlayerKeys.push('index');
                }

                const player = Object.fromEntries(
                    Object.entries(state.player).filter(
                        ([key]) => !excludedPlayerKeys.includes(key),
                    ),
                ) as typeof state.player;

                if (!shouldRestorePlayQueue) {
                    return { player };
                }

                // Queue pruning and IDB writes are handled in `playerStoreStorage` so we only
                // serialize the large queue when the queue slice reference actually changes.
                return { player, queue: state.queue };
            },
            storage: playerStoreStorage,
            version: 4,
        },
    ),
);

export const usePlayerStore = createSelectors(usePlayerStoreBase);

export const usePlayerActions = () => {
    const actions = usePlayerStoreBase(
        useShallow((state) => ({
            addToQueueByType: state.addToQueueByType,
            addToQueueByUniqueId: state.addToQueueByUniqueId,
            clearQueue: state.clearQueue,
            clearSelected: state.clearSelected,
            decreaseVolume: state.decreaseVolume,
            getQueue: state.getQueue,
            increaseVolume: state.increaseVolume,
            isFirstTrackInQueue: state.isFirstTrackInQueue,
            isLastTrackInQueue: state.isLastTrackInQueue,
            mediaAutoNext: state.mediaAutoNext,
            mediaNext: state.mediaNext,
            mediaPause: state.mediaPause,
            mediaPlay: state.mediaPlay,
            mediaPlayByIndex: state.mediaPlayByIndex,
            mediaPrevious: state.mediaPrevious,
            mediaSeekToTimestamp: state.mediaSeekToTimestamp,
            mediaSkipBackward: state.mediaSkipBackward,
            mediaSkipForward: state.mediaSkipForward,
            mediaStop: state.mediaStop,
            mediaToggleMute: state.mediaToggleMute,
            mediaTogglePlayPause: state.mediaTogglePlayPause,
            moveSelectedTo: state.moveSelectedTo,
            moveSelectedToBottom: state.moveSelectedToBottom,
            moveSelectedToNext: state.moveSelectedToNext,
            moveSelectedToTop: state.moveSelectedToTop,
            setCrossfadeDuration: state.setCrossfadeDuration,
            setCrossfadeStyle: state.setCrossfadeStyle,
            setPauseOnNextSongEnd: state.setPauseOnNextSongEnd,
            setQueue: state.setQueue,
            setRepeat: state.setRepeat,
            setShuffle: state.setShuffle,
            setSpeed: state.setSpeed,
            setTransitionType: state.setTransitionType,
            setVolume: state.setVolume,
            shuffle: state.shuffle,
            shuffleAll: state.shuffleAll,
            shuffleSelected: state.shuffleSelected,
            toggleRepeat: state.toggleRepeat,
            toggleShuffle: state.toggleShuffle,
        })),
    );

    return useMemo(
        () => ({
            ...actions,
            setTimestamp: setTimestampStore,
        }),
        [actions],
    );
};

export type AddToQueueByPlayType = Play;

export type AddToQueueByUniqueId = {
    edge: 'bottom' | 'left' | 'right' | 'top' | null;
    pinAboveUpNext?: boolean;
    uniqueId: string;
};

export type AddToQueueOptions = {
    filter?: (song: Song) => boolean;
    skipConfirmation?: boolean;
};

export type AddToQueueType = AddToQueueByPlayType | AddToQueueByUniqueId;

export async function addToQueueByData(type: AddToQueueType, data: Song[]) {
    const items = data.map(toQueueSong);

    if (typeof type === 'string') {
        usePlayerStoreBase.getState().addToQueueByType(items, type);
    } else {
        const normalizedEdge = type.edge === 'top' ? 'top' : 'bottom';
        usePlayerStoreBase
            .getState()
            .addToQueueByUniqueId(
                items,
                type.uniqueId,
                normalizedEdge,
                undefined,
                type.pinAboveUpNext,
            );
    }
}

export const subscribePlayerQueue = (
    onChange: (queue: QueueData, prevQueue: QueueData) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.queue,
        (queue, prevQueue) => {
            onChange(queue, prevQueue);
        },
    );
};

export const subscribeCurrentTrack = (
    onChange: (
        properties: { index: number; song: QueueSong | undefined },
        prev: { index: number; song: QueueSong | undefined },
    ) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => {
            const queue = state.getQueue();
            let index = state.player.index;

            if (isShuffleEnabled(state)) {
                index = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            return { index, song: queue.items[index] };
        },
        (song, prevSong) => {
            onChange(song, prevSong);
        },
        {
            equalityFn: (a, b) => {
                return a.song?._uniqueId === b.song?._uniqueId;
            },
        },
    );
};

export const subscribeNextSongInsertion = (onChange: (song: QueueSong | undefined) => void) => {
    return usePlayerStoreBase.subscribe(
        (state) => {
            const queue = state.getQueue();
            let queueIndex = state.player.index;
            const repeat = state.player.repeat;

            // If shuffle is enabled, map shuffled position to actual queue position
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(queueIndex, state.queue.shuffled);
            }

            const currentSong = queue.items[queueIndex];

            // Calculate next song based on shuffle and repeat settings
            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                // Calculate next in shuffled order
                const nextShuffledIndex = state.player.index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                    nextSong = queue.items[nextQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to first in shuffled order
                    const firstQueueIndex = state.queue.shuffled[0];
                    nextSong = queue.items[firstQueueIndex];
                }
            } else {
                nextSong = calculateNextSong(queueIndex, queue.items, repeat);
            }

            return {
                currentUniqueId: currentSong?._uniqueId,
                nextSong,
            };
        },
        (current, prev) => {
            if (!prev) {
                return;
            }

            // Still on the same track, but the upcoming song changed (queue edit: insert, reorder, etc.).
            // Do not require the current track's queue index to stay fixed — e.g. inserting *before* the
            // current item shifts its index in `queue.default`, and the old check missed that case.
            const sameTrackStillPlaying =
                current.currentUniqueId !== undefined &&
                current.currentUniqueId === prev.currentUniqueId;

            if (sameTrackStillPlaying && current.nextSong?._uniqueId !== prev.nextSong?._uniqueId) {
                onChange(current.nextSong);
            }
        },
        {
            // Always allow the subscription to fire so we can check conditions in the callback
            equalityFn: () => false,
        },
    );
};

export const subscribePlayerVolume = (
    onChange: (properties: { volume: number }, prev: { volume: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.volume,
        (volume, prevVolume) => {
            onChange({ volume }, { volume: prevVolume });
        },
    );
};

export const subscribePlayerStatus = (
    onChange: (properties: { status: PlayerStatus }, prev: { status: PlayerStatus }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.status,
        (status, prevStatus) => {
            onChange({ status }, { status: prevStatus });
        },
    );
};

export const subscribePlayerMute = (
    onChange: (properties: { muted: boolean }, prev: { muted: boolean }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.muted,
        (muted, prevMuted) => {
            onChange({ muted }, { muted: prevMuted });
        },
    );
};

export const subscribePlayerSpeed = (
    onChange: (properties: { speed: number }, prev: { speed: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.speed,
        (speed, prevSpeed) => {
            onChange({ speed }, { speed: prevSpeed });
        },
    );
};

export const subscribePlayerRepeat = (
    onChange: (properties: { repeat: PlayerRepeat }, prev: { repeat: PlayerRepeat }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.repeat,
        (repeat, prevRepeat) => {
            onChange({ repeat }, { repeat: prevRepeat });
        },
    );
};

export const subscribePlayerShuffle = (
    onChange: (properties: { shuffle: PlayerShuffle }, prev: { shuffle: PlayerShuffle }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.shuffle,
        (shuffle, prevShuffle) => {
            onChange({ shuffle }, { shuffle: prevShuffle });
        },
    );
};

export const subscribeQueueCleared = (onChange: () => void) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.queue,
        (queue, prevQueue) => {
            // Detect if queue became empty
            const wasNotEmpty = prevQueue.default.length > 0;
            const isEmpty = queue.default.length === 0;

            if (wasNotEmpty && isEmpty) {
                onChange();
            }
        },
    );
};

export const usePlayerProperties = () => {
    return usePlayerStoreBase(
        useShallow((state) => ({
            crossfadeDuration: state.player.crossfadeDuration,
            crossfadeStyle: state.player.crossfadeStyle,
            isMuted: state.player.muted,
            playerNum: state.player.playerNum,
            repeat: state.player.repeat,
            shuffle: state.player.shuffle,
            speed: state.player.speed,
            status: state.player.status,
            transitionType: state.player.transitionType,
            volume: state.player.volume,
        })),
    );
};

export const usePlayerDuration = () => {
    return usePlayerStoreBase((state) => {
        const queue = state.getQueue();
        let index = state.player.index;

        // If shuffle is enabled, map shuffled position to actual queue position
        if (state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0) {
            if (index >= 0 && index < state.queue.shuffled.length) {
                index = state.queue.shuffled[index];
            }
        }

        const currentTrack = queue.items[index];
        return currentTrack?.duration;
    });
};

export const usePlayerData = (): PlayerData => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const queue = state.getQueue();
            const index = state.player.index;

            // If shuffle is enabled, map shuffled position to actual queue position for display
            let queueIndex = index;
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            const currentSong = queue.items[queueIndex];
            const repeat = state.player.repeat;

            // For previousSong calculation, we need to consider the shuffled order
            let previousSong: QueueSong | undefined;
            if (isShuffleEnabled(state)) {
                // Calculate previous in shuffled order
                const previousShuffledIndex = index - 1;
                if (previousShuffledIndex >= 0) {
                    const previousQueueIndex = state.queue.shuffled[previousShuffledIndex];
                    previousSong = queue.items[previousQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to last in shuffled order
                    const lastShuffledIndex = state.queue.shuffled.length - 1;
                    const lastQueueIndex = state.queue.shuffled[lastShuffledIndex];
                    previousSong = queue.items[lastQueueIndex];
                }
            } else {
                previousSong = queueIndex > 0 ? queue.items[queueIndex - 1] : undefined;
            }

            // For nextSong calculation, we need to consider the shuffled order
            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                // Calculate next in shuffled order
                const nextShuffledIndex = index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                    nextSong = queue.items[nextQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to first in shuffled order
                    const firstQueueIndex = state.queue.shuffled[0];
                    nextSong = queue.items[firstQueueIndex];
                }
            } else {
                nextSong = calculateNextSong(queueIndex, queue.items, repeat);
            }

            const { player1, player2 } = getDualPlayerSongs(
                state.player.playerNum,
                currentSong,
                nextSong,
                repeat,
            );

            return {
                currentSong,
                index: queueIndex, // Return the actual queue position for display
                nextSong,
                num: state.player.playerNum,
                player1,
                player2,
                previousSong,
                queueLength: state.queue.default.length,
                status: state.player.status,
            };
        }),
    );
};

export const updateQueueFavorites = (ids: string[], favorite: boolean) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.userFavorite = favorite;
            }
        });
    });
};

export const updateQueueRatings = (ids: string[], rating: null | number) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.userRating = rating;
            }
        });
    });
};

export const incrementQueuePlayCount = (ids: string[]) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.playCount = (song.playCount || 0) + 1;
            }
        });
    });
};

export const updateQueueSong = (songId: string, updatedSong: Song) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (song.id === songId) {
                const uniqueId = song._uniqueId;
                state.queue.songs[song._uniqueId] = {
                    ...updatedSong,
                    _contextPlaylistId: song._contextPlaylistId,
                    _uniqueId: uniqueId,
                };
            }
        });
    });
};

export const useCurrentPlaylistContextId = () => {
    return usePlayerStoreBase((state) => state.getCurrentSong()?._contextPlaylistId ?? null);
};

export const usePlayerMuted = () => {
    return usePlayerStoreBase((state) => state.player.muted);
};

export const usePlayerRepeat = () => {
    return usePlayerStoreBase((state) => state.player.repeat);
};

export const usePlayerShuffle = () => {
    return usePlayerStoreBase((state) => state.player.shuffle);
};

export const usePlayerStatus = () => {
    return usePlayerStoreBase((state) => state.player.status);
};

export const usePlayerHydrated = () => {
    return usePlayerStoreBase((state) => state.hydrated);
};

export const useMpvInitialized = () => {
    return usePlayerStoreBase((state) => state.mpvInitialized);
};

export const setMpvInitialized = (mpvInitialized: boolean) => {
    usePlayerStoreBase.setState({ mpvInitialized });
};

export const usePlayerVolume = () => {
    return usePlayerStoreBase((state) => state.player.volume);
};

export const usePlayerSpeed = () => {
    return usePlayerStoreBase((state) => state.player.speed);
};

export const usePlayerSong = () => {
    return usePlayerStoreBase(
        (state) => {
            return state.getCurrentSong();
        },
        (prev, next) => {
            return (
                prev?._uniqueId === next?._uniqueId &&
                prev?.userFavorite === next?.userFavorite &&
                prev?.userRating === next?.userRating
            );
        },
    );
};

export const usePlayerSongProperties = <T extends keyof QueueSong>(
    properties: T[],
): Partial<Pick<QueueSong, T>> => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const song = state.getCurrentSong();
            if (!song) {
                return {};
            }

            const result = {} as Pick<QueueSong, T>;

            for (const prop of properties) {
                result[prop] = song[prop];
            }
            return result;
        }),
    );
};

export const usePlayerNum = () => {
    return usePlayerStoreBase((state) => state.player.playerNum);
};

export const usePlayerQueue = () => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const songs = state.queue.songs;
            const queue = state.queue.default;
            const result: QueueSong[] = [];
            for (const id of queue) {
                const song = songs[id];
                if (song) result.push(song);
            }
            return result;
        }),
    );
};

function cleanupOrphanedSongs(state: any): boolean {
    const allQueueIds = new Set([
        ...state.queue.default,
        // shuffled now contains indexes, not uniqueIds, so we don't include it here
    ]);

    const songs = state.queue.songs;
    const songIds = Object.keys(songs);
    let hasOrphans = false;
    const orphanedIds: string[] = [];

    for (const songId of songIds) {
        if (!allQueueIds.has(songId)) {
            orphanedIds.push(songId);
            hasOrphans = true;
        }
    }

    if (hasOrphans) {
        const cleanedSongs: Record<string, QueueSong> = {};
        for (const songId of songIds) {
            if (!orphanedIds.includes(songId)) {
                cleanedSongs[songId] = songs[songId];
            }
        }
        state.queue.songs = cleanedSongs;
    }

    return hasOrphans;
}

function findIndexWithPreviousAlbum(queueItems: QueueSong[], currentIndex: number) {
    const queueBeforeCurrent = queueItems.slice(0, currentIndex);
    const currentItem = queueItems[currentIndex];

    const previousAlbumIdInQueue = queueBeforeCurrent.findLast(
        (i) => i.albumId !== currentItem.albumId,
    )?.albumId;

    let prevIndex = -1;

    if (previousAlbumIdInQueue) {
        for (let index = queueBeforeCurrent.length - 1; index > -1; index--) {
            const element = queueBeforeCurrent[index];
            if (element.albumId === previousAlbumIdInQueue) {
                prevIndex = index;
            }
            if (prevIndex > -1 && element.albumId !== previousAlbumIdInQueue) {
                break;
            }
        }
    }

    return prevIndex;
}

function findLastAlbumRange(queueItems: QueueSong[]) {
    const lastAlbumId = queueItems.at(-1)?.albumId;
    const rangeEnd = queueItems.length - 1;
    let rangeStart = rangeEnd;

    for (let index = rangeEnd; index > -1; index--) {
        const element = queueItems[index];
        rangeStart = index;
        if (element.albumId !== lastAlbumId) {
            break;
        }
    }

    return [rangeStart + 1, rangeEnd];
}

function recalculatePlayerIndex(state: any, queue: string[]) {
    const currentTrack = state.getCurrentSong() as QueueSong | undefined;

    if (!currentTrack) {
        return;
    }

    const index = queue.findIndex((id) => id === currentTrack._uniqueId);
    state.player.index = Math.max(0, index);
}

function toQueueSong(item: Song): QueueSong {
    return {
        ...item,
        _uniqueId: nanoid(),
    };
}
