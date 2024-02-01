import {CommunicationError, remote, ServerSession} from "restfuncs-server";
import _ from "underscore";

class NotLoggedInError extends CommunicationError {
    name= "NotLoggedInError"; // Properly flag it for the client to recognize

    constructor() {
        super("Not logged in",{log: false, httpStatusCode: 401})
    }
}

export class MainframeSession extends ServerSession {
    private value?: string

    @remote()
    getValue(): string {
        let raw = this.call.req?ServerSession.getFixedCookieSessionFromRequest(this.call.req):this.call.socketConnection!.cookieSession;
        return `${this.value}\nraw: ${JSON.stringify(raw)}`;
    }

    @remote()
    setValue(value: string) {
        this.value = value;
    }

    @remote()
    public destroy() {
        super.destroy();
    }
}