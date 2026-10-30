const tails = new Map<string, Promise<void>>();

const ignore = (): void => undefined;

/**
 * In-process async mutex: runs `task` once every task queued earlier under the same key has settled, whether it
 * succeeded or failed. Tasks must not queue another task under their own key, or they wait for themselves.
 */
export function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(ignore, ignore);
    tails.set(key, tail);
    void tail.then(() => {
        if (tails.get(key) === tail) {
            tails.delete(key);
        }
    });
    return result;
}
