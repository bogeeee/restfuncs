import {RestError, RestService} from "restfuncs-server";
import _ from "underscore";
import {TestServiceSession} from "./TestsService";

class NotLoggedInError extends RestError {
    name= "NotLoggedInError"; // Properly flag it for the client to recognize

    constructor() {
        super("Not logged in",{log: false, httpStatusCode: 401})
    }
}

export class MainframeService extends RestService {
    // If you have multiple services, you may want to move session, doCall and login into a common baseclass

    session = new TestServiceSession()

    // Interceptor that checks for login on every function call
    protected async doCall(funcName: string, args: any[]) {
        if(!_(["login", "myUnrestrictedFunction"]).contains(funcName) && !this.session.user) {
            throw new NotLoggedInError();
        }
        return await super.doCall(funcName, args);
    }

    async login(userName: string) {
        const shallPass = _(["admin", "alice", "bob"]).contains(userName.toLowerCase());
        if(shallPass) {
            this.session.user = userName
        }
        return shallPass
    }

    async multiplyBy10(value: number) {
        return `Logged in as ${this.session.user}. Result is: ${value * 10}`;
    }

    async getConcat(a: string, b: number) {
        return `Logged in as ${this.session.user}. Result is: ${a + b}`;
    }
}