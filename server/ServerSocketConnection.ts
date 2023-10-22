import crypto from "node:crypto";
import { SecurityPropertiesOfHttpRequest } from "./ServerSession";

export class ServerSocketConnection {
    id = crypto.randomBytes(16);

    conn: unknown

    /**
     * The session values that were obtained from a http call.
     * Lazy / can be undefined if ne session-cookie was send. I.e the user did not yet login
     */
    session?: object

    //cache_allowedSecurityGroupIds = new Set<string>(); // TODO: implement faster approving

    /**
     *
     */
    clientsSecurityProperties = new Map<string, SecurityPropertiesOfHttpRequest>()


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