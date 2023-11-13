### SessionCookie change detection

To allow socket clients to detect, when a http call made a change to the cookieSession, on every change:
- Another cookie (name=rfSessState; value) will be sent in clear-text and non 'http-only', which indicates the id and new version of the session. This way, we can detect changes across browser tabs through polling. 
- More than polling, we need that info immediately cause the user's flow relies on it. Therefore, also a header is sent, with the same content to indicate the change.  
See [session playground](../tests/session-playground)
Note: Actual changes to the cookie session by the socket connection will always be committed to the http side. So this is the point to hook on. 