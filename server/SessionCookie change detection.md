### SessionCookie change detection

To allow socket clients to detect, when a http call made a change to the cookieSession, on every change there will bea nother cookie (name=rfSessState; value) be sent in clear-text and non 'http-only', which indicates the id and new version of the session. This way, we can detect changes across browser tabs. 
See [session playground](../tests/session-playground)
Note: Actual changes to the cookie session by the socket connection will always be committed to the http side. So this is the point to hook on. 