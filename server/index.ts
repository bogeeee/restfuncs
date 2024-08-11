// Diagnosis for web packagers. Please keep this at the file header:
import {Buffer} from 'node:buffer'; // *** If you web packager complains about this line, it did not properly (tree-)shake off your referenced ServerSession class and now wants to include ALL your backend code, which is not what we want. It can be hard to say exactly, why it decides to follow (not tree-shake) it, so Keep an eye on where you placed the line: `new RestfuncsClient<YourServerSession>(...)` or where you included YourServerSession in a return type. **
Buffer.alloc(0); // Provoke usage of some stuff that the browser doesn't have. Keep this here !


import 'reflect-metadata' // Must import

export {RestfuncsServer, ServerOptions, restfuncsExpress, getServerInstance, SessionValidator} from "./Server"
export {ServerSession, ServerSessionOptions, remote, RemoteMethodOptions, ClientCallback} from "./ServerSession";
export {DownCallError} from "./ServerSocketConnection";
export {ClientCallbacks} from "./util/ClientCallbacks"
export {ClientCallbacksForEntities} from "./util/ClientCallbacksForEntities"
export {ClientCallbacksCommon} from "./util/ClientCallbacksCommon"
export {UploadFile} from "restfuncs-common"
export {CommunicationError} from "./CommunicationError";








