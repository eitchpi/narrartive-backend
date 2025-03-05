let lastError = null;

export function recordError(message) {
    lastError = {
        message,
        time: new Date().toISOString(),
    };
}

export function getLastError() {
    return lastError;
}
