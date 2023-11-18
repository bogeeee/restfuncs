import {ServerSessionOptions, ServerSession, remote} from "restfuncs-server";
import session from "express-session";
import express from "express"
import _ from "underscore";
import {shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util"


export class ControlService extends ServerSession {
    static options: ServerSessionOptions = {allowedOrigins: "all", exposeErrors: true, devDisableSecurity: true}

    @remote()
    async resetSession() {
        this.destroy()
    }

    static lock?: ExternalPromise<void>

    @remote()
    async getLock() {
        if(ControlService.lock) {
            return await ControlService.lock;
        }

        ControlService.lock = new ExternalPromise()
    }

    @remote()
    releaseLock() {
        ControlService.lock?.resolve()
        ControlService.lock = undefined;
    }


    @remote()
    async getCorsReadTokenForService(id: string) {
        // @ts-ignore
        return this.getServiceClass(id).getOrCreateSecurityToken(this.call.req!.session, "corsReadToken")
    }


    @remote()
    async getCsrfTokenForService(id: string) {
        if(!this.call.req) {
            throw new Error("Not called by http")
        }
        const ServiceClass = this.getServiceClass(id);
        return ServiceClass.getCsrfToken(this.call.req, this.call.res!)
    }

    private getServiceClass(id: string) {
        let server = this.clazz.server;
        const ServiceClass = server.serverSessionClasses.get(id);
        if (!ServiceClass) {
            throw new Error(`No class found with id: ${id}`);
        }
        return ServiceClass;
    }

    /**
     * The browser code does not have direct access to shieldTokenAgainstBREACH_unwrap or node's Buffer class
     * @param shieldedToken
     */
    @remote()
    async shieldTokenAgainstBREACH_unwrap(shieldedToken: string): Promise<string> {
        return shieldTokenAgainstBREACH_unwrap(shieldedToken).toString("hex");
    }


}



/**
 * Exposes the resolve and reject methods to the outside
 */
class ExternalPromise<T> implements Promise<T>{
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