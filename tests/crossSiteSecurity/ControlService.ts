import {ServerSessionOptions, ServerSession} from "restfuncs-server";
import session from "express-session";
import express from "express"
import _ from "underscore";
import {shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util"

const app = express()


export class ControlService extends ServerSession {
    services: { [name: string]: { service: ServerSession;} }

    constructor(services: { [p: string]: { service: ServerSession } }) {
        super();
        this.services = services;
    }

    async resetSession() {
        if(!this.req.session) {
            return;
        }

        const session = this.req.session;

        await new Promise<void>(function executor(resolve, reject) { // with an arrow function, it gives some super strange compile error
            session.destroy((err) => {if(!err) resolve(); else reject(err)})
        })
    }
    async getCorsReadTokenForService(name: string) {

        /**
         * Nonexisting props and methods get copied to the target so that it's like the target exends the base class .
         * @param target
         * @param base
         */
        function baseOn(target: {[index: string]: any }, base: {[index: string]: any }) {
            [...Object.keys(base), ..._.functions(base)].map(propName => {
                if(target[propName] === undefined) {
                    target[propName] = base[propName];
                }
            })
        }

        const service = {req: this.req, session: this.session}
        baseOn(service, this.services[name].service);
        // @ts-ignore
        return await service.getCorsReadToken();
    }


    async getCsrfTokenForService(name: string) {
        return this.services[name].service.getCsrfToken(this.req.session)
    }

    /**
     * The browser code does not have direct access to shieldTokenAgainstBREACH_unwrap or node's Buffer class
     * @param shieldedToken
     */
    async shieldTokenAgainstBREACH_unwrap(shieldedToken: string): Promise<string> {
        return shieldTokenAgainstBREACH_unwrap(shieldedToken).toString("hex");
    }

}