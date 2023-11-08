// A wrapper file for ESM to avoid the 'dual package hazard'. See https://nodejs.org/api/packages.html#approach-1-use-an-es-module-wrapper

// Diagnosis for web bundlers. Please keep this at the file header:
import {Buffer} from 'node:buffer'; // *** If your bundler complains about this line, it did not properly (tree-)shake off your referenced ServerSession class and now wants to include ALL your backend code, which is not what we want.***
Buffer.alloc(0); // Provoke usage of some stuff that the browser doesn't have. Keep this here !


import 'reflect-metadata' // Must import

import cjsServer from "./Server.js"
export const RestfuncsServer = cjsServer.cjsServer
export const restfuncsExpress = cjsServer.restfuncsExpress
export const ServerOptions = cjsServer.ServerOptions
export const getServerInstance = cjsServer.getServerInstance
export const SessionValidator = cjsServer.SessionValidator

import cjsServerSession from "./ServerSession.js";
export const ServerSession = cjsServerSession.ServerSession
export const ServerSessionOptions = cjsServerSession.ServerSessionOptions
export const remote = cjsServerSession.remote
export const RemoteMethodOptions = cjsServerSession.RemoteMethodOptions

import cjsCommunicationError from "./CommunicationError.js"
export const CommunicationError = cjsCommunicationError.CommunicationError;