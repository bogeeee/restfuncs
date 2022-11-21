import {RestService} from "@restfuncs/server";
import _ from "underscore";

class NotLoggedInError extends Error {
    name= "NotLoggedInError"; // Properly flag it for the client to recognize
}

export class MainframeService extends RestService {
    // If you have multiple services, you may want to move session, doCall and login into a common baseclass

    session: {
        logonUser?: string
    }

    // Interceptor that checks for login on every function call
    protected async doCall(funcName: string, args: any[]) {
        if(!_(["login", "myUnrestrictedFunction"]).contains(funcName) && !this.session.logonUser) {
            throw new NotLoggedInError("Not logged in")
        }
        return await super.doCall(funcName, args);
    }

    async login(userName: string) {
        const shallPass = _(["admin", "alice", "bob"]).contains(userName.toLowerCase());
        if(shallPass) {
            this.session.logonUser = userName
        }
        return shallPass
    }

    async multiplyBy10(value: number) {
        return value * 10
    }
}