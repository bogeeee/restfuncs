import {ErrorWithExtendedInfo} from "restfuncs-server/Util";

type VisitReplaceContext = {
    /**
     * Not safely escaped. Should be used for diag only !
     */
    diagnosis_path: string
}

function diagnosis_jsonPath(key: unknown) {
    if(!Number.isNaN(Number(key))) {
        return `[${key}]`;
    }
    return `.${key}`;
}

/**
 * Usage:
 *  <pre><code>
 *  const result = visitReplace(target, (value, visitChilds, context) => {
 *      return value === 'needle' ? 'replaced' : visitChilds(value, context)
 *  });
 *  </code></pre>
 *
 * @param value
 * @param visitor
 * @param trackContext whether to pass on the context object. This hurts performance because the path is concatted every time, so use it only when needed. Setting this to "onError" re-executes the visitprelace with the concetxt when an error was thrown
 */
export function visitReplace<O extends object>(value: O, visitor: ((value: unknown, visitChilds: (value: unknown, context?: VisitReplaceContext) => unknown, context?: VisitReplaceContext) => unknown ), trackContext: boolean | "onError" = false): O {
    const visisitedObjects = new Set<object>()

    function visitChilds(value: unknown, context?: VisitReplaceContext) {
        if(value === null) {
            return value;
        }
        else if(typeof value === "object") {
            const obj = value as object;
            if(visisitedObjects.has(obj)) {
                return value; // don't iterate again
            }
            visisitedObjects.add(obj);

            for (let k in obj) {
                const key = k as keyof object;
                const value = obj[key];
                let newValue = visitor(value, visitChilds, context?{...context, diagnosis_path: `${context.diagnosis_path}${diagnosis_jsonPath(key)}`}:undefined);
                // @ts-ignore
                obj[key] = newValue;
            }
        }
        return value;
    }

    if(trackContext === "onError") {
        try {
            return visitChilds(value,  undefined) as O; // Fast try without context
        }
        catch (e) {
            return visitReplace(value,  visitor, true); // Try again with context
        }
    }

    return visitChilds(value, trackContext?{diagnosis_path: ""}:undefined) as O;
}

/**
 * Exposes the resolve and reject methods to the outside
 */
export class ExternalPromise<T> implements Promise<T> {
    private promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: any) => void;

    constructor() {

        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onFulfilled, onRejected);
    }

    catch<TResult = never>(
        onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
    ): Promise<T | TResult> {
        return this.promise.catch(onRejected);
    }

    finally(onFinally?: (() => void) | null): Promise<T> {
        return this.promise.finally(onFinally);
    }

    readonly [Symbol.toStringTag]: string = "WrappedPromise"; // Must offer this when implementing Promise. Hopefully this is a proper value
}


/**
 * When running with jest, the cause is not displayed. This fixes it.
 * @param error
 */
export function fixErrorForJest(error: Error) {
    if(process.env.JEST_WORKER_ID !== undefined) { // Are we running with jest ?
        const cause = (error as any).cause;
        if(cause) {
            error.message = `${error.message}, cause: ${errorToString(cause)}\n*** end of cause ***`
        }
    }
    return error;
}

export function errorToString(e: any): string {
    // Handle other types:
    if (!e || typeof e !== "object") {
        return String(e);
    }
    if (!e.message) { // e is not an ErrorWithExtendedInfo ?
        return JSON.stringify(e);
    }
    e = <ErrorWithExtendedInfo>e;

    return (e.name ? `${e.name}: ` : "") + (e.message || String(e)) +
        (e.stack ? `\n${e.stack}` : '') +
        (e.fileName ? `\nFile: ${e.fileName}` : '') + (e.lineNumber ? `, Line: ${e.lineNumber}` : '') + (e.columnNumber ? `, Column: ${e.columnNumber}` : '') +
        (e.cause ? `\nCause: ${errorToString(e.cause)}` : '')
}