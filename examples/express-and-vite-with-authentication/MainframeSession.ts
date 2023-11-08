import {CommunicationError, remote, ServerSession} from "restfuncs-server";
import _ from "underscore";

class NotLoggedInError extends CommunicationError {
    name= "NotLoggedInError"; // Properly flag it for the client to recognize

    constructor() {
        super("Not logged in",{log: false, httpStatusCode: 401})
    }
}

export class MainframeSession extends ServerSession {
    // If you have multiple services, you may want to move session, doCall and login into a common baseclass

    logonUser?: string

    // Interceptor that checks for login on every function call
    protected async doCall(funcName: string, args: any[]) {
        if(!_(["login", "myUnrestrictedFunction"]).contains(funcName) && !this.logonUser) {
            throw new NotLoggedInError()
        }
        return await super.doCall(funcName, args);
    }

    @remote()
    async login(userName: string) {
        const shallPass = _(["admin", "alice", "bob"]).contains(userName.toLowerCase());
        if(shallPass) {
            this.logonUser = userName
        }
        return shallPass
    }

    @remote()
    async multiplyBy10(value: number) {
        return value * 10
    }
}