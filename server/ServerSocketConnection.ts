import crypto from "node:crypto";
import {SecurityPropertiesOfHttpRequest, ServerSession} from "./ServerSession";
import {RestfuncsServer} from "./Server";

export class ServerSocketConnection {
    id = crypto.randomBytes(16);

    server: RestfuncsServer

    conn: unknown

    /**
     * The raw cookie-session values that were obtained from a http call.
     * Lazy / can be undefined if no session-cookie was send. I.e the user did not yet login
     */
    cookieSession?: object

    //cache_allowedSecurityGroupIds = new Set<string>(); // TODO: implement faster approving

    /**
     *
     */
    securityGroup2SecurityPropertiesOfHttpRequest?: Map<SecurityGroup, SecurityPropertiesOfHttpRequest>

    serverSessionClass2SecurityPropertiesOfHttpRequest?: Map<typeof ServerSession, SecurityPropertiesOfHttpRequest>


    constructor(server: RestfuncsServer) {
        this.server = server;

        if(this.server.serverOptions.socket_requireAccessProofForIndividualServerSession) {
            this.serverSessionClass2SecurityPropertiesOfHttpRequest = new Map();
        }
        else {
            this.securityGroup2SecurityPropertiesOfHttpRequest = new Map();
        }
    }

    onCall(clientCallId: number, ServerSessionClassId: string, methodName: string, args: any[]) {
        // Create new session object
        // Wrap with a proxy that serves the properties of session.
        // Can we get the session lazy ?
        // Check the validity of the session

        // do the call
        // if(sessionModified) {
        //      // hand out the session. Use a special token type so this can only be used to install the session as the main. Otherwise an attacker could have 2 valid sessions in stock.
        // }
    }

    onInstallSession() {

    }
}