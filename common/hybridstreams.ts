import _ from "underscore";
import {Readable} from "node:stream";

let isNode = false;
if (typeof process === 'object') {
    if (typeof process.versions === 'object') {
        if (typeof process.versions.node !== 'undefined') {
            isNode = true;
        }
    }
}

/**
 * Enhances rs and makes it implement all fields / methods from Readable.
 * <p>
 * Creates an internal peer Reader that reads from rs. It Will add properties methods that forward from rs to the internal peer Reader
 * </p>
 * @param rs
 */
export function readableStreamToHybridStream(rs: ReadableStream): ReadableStream & Readable {
    if(!isNode) {
        return rs as any;
    }

    //@ts-ignore
    if(rs._readable) { // Already enhanced ?
        return rs as any;
    }

    // State:
    let reader: ReadableStreamDefaultReader
    function getReader() {
        return reader || (reader = rs.getReader());
    }

    const readable = new Readable({
        read(this: Readable, size: number) {
            (async () => {
                try {
                    const result = await getReader().read();
                    if(!result.done) {
                        if(result.value === null) {
                            throw new Error("Illeagal state");
                        }
                        this.push(result.value);
                    }
                    else {
                        this.push(null);
                    }
                }
                catch (e) {
                    this.destroy!((e !=null && e instanceof Error)?e:undefined);
                }
            })()
        },
        destroy(error: Error | null, callback: (error: (Error | null)) => void) {
            rs.cancel(error).catch(callback);
        }
    });
    //@ts-ignore
    rs._readable = readable;

    // Forward readonly properties from rs to readable
    const readonlyProps = ["closed", "errored", "readable", "readableAborted", "readableDidRead","readableEncoding","readableEnded","readableFlowing", "readableHighWaterMark","readableLength","readableObjectMode"];
    readonlyProps.forEach(propName => {
        //@ts-ignore
        if(rs[propName]) {
            throw new Error(`Property already exists: ${propName}`);
        }
        Object.defineProperty(rs, propName, {
            get(): any {
                //@ts-ignore
                return readable[propName];
            }
        })
    });

    // Forward "destroyed property from rs to readable:
    Object.defineProperty(rs, "destroyed", {
        get(): any {
            return readable.destroyed;
        },
        set(v: any) {
          readable.destroyed = v;
        }
    });

    // Forward methods from rs to readable:
    const methods = ["addListener", "destroy", "emit", "eventNames", "getMaxListeners", "isPaused", "listenerCount", "listeners", "off", "on", "once", "pause", "pipe", "prependListener", "prependOnceListener", "push", "rawListeners", "read", "removeAllListeners","removeListener","resume","setEncoding","setMaxListeners","unpipe", "unshift","wrap"];
    methods.forEach(methodName => {
        //@ts-ignore
        if(rs[methodName]) {
            throw new Error(`Method already exists: ${String(methodName)}`);
        }
        //@ts-ignore
        rs[methodName] = (...args: any[]) => {
            //@ts-ignore
            readable[methodName].apply(readable, args);
        }
    });

    // Method Symbol.asyncIterator exists on both. They both seem to act the same way, so we leave the original from ReadableStream


    return rs as any;
}
