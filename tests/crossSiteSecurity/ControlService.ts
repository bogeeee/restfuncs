import {ServerSessionOptions, ServerSession, remote} from "restfuncs-server";
import session from "express-session";
import express from "express"
import _ from "underscore";
import {shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util"


export class ControlService extends ServerSession {
    static options: ServerSessionOptions = {allowedOrigins: "all", exposeErrors: true}

    @remote()
    async resetSession() {
        if(!this.req?.session) {
            return;
        }

        const session = this.req.session as any;

        await new Promise<void>(function executor(resolve, reject) { // with an arrow function, it gives some super strange compile error
            session.destroy((err: any) => {if(!err) resolve(); else reject(err)})
        })
    }

    @remote()
    async getCorsReadTokenForService(id: string) {
        // @ts-ignore
        return this.getServiceClass(id).getOrCreateSecurityToken(this.req!.session, "corsReadToken")
    }


    @remote()
    async getCsrfTokenForService(id: string) {
        const ServiceClass = this.getServiceClass(id);
        return ServiceClass.getCsrfToken(this.req!.session)
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