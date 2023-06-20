import {
    browserMightNotSupportCORS,
    shieldTokenAgainstBREACH,
    shieldTokenAgainstBREACH_unwrap
} from "restfuncs-server/Util";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


test('shieldTokenAgainstBREACH', async () => {
    function checkConsistant(value: string) {
        const buffer = Buffer.from(value, "utf8");
        expect(shieldTokenAgainstBREACH_unwrap(shieldTokenAgainstBREACH(buffer)).toString("utf8")).toBe(value);
    }

    expect(shieldTokenAgainstBREACH(Buffer.from(""))).toBe("--");
    checkConsistant("")
    checkConsistant("0")
    checkConsistant("abcdef")
});

test('browserMightNotSupportCORS', async () => {
    expect(browserMightNotSupportCORS({userAgent: ""})).toBeFalsy()

    // Opera Mini:
    expect(browserMightNotSupportCORS({userAgent: "something...Opera Mini..."})).toBeTruthy()

    // Chrome:
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (X11; U; Linux i686; en-US) AppleWebKit/532.4 (KHTML, like Gecko) Chrome/4.0.237.0 Safari/532.4 Debian"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.79 Safari/537.36"})).toBeFalsy()

    // Safari:
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Macintosh; U; PPC Mac OS X; fr-fr) AppleWebKit/85.8.5 (KHTML, like Gecko) Safari/85.8.1"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Windows; U; Windows NT 5.1; pt-BR) AppleWebKit/525+ (KHTML, like Gecko) Version/3.0 Safari/523.15"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Macintosh; U; Intel Mac OS X; it-it) AppleWebKit/523.10.6 (KHTML, like Gecko) Version/3.0.4 Safari/523.10.6"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Windows; U; Windows NT 6.0; fr-FR) AppleWebKit/530.19.2 (KHTML, like Gecko) Version/4.0.2 Safari/530.19.1"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Macintosh; U; PPC Mac OS X 10_4_11; ja-jp) AppleWebKit/533.16 (KHTML, like Gecko) Version/4.1 Safari/533.16"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Windows; U; Windows NT 6.0; ja-JP) AppleWebKit/533.16 (KHTML, like Gecko) Version/5.0 Safari/533.16"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (iPad; U; CPU OS 4_3 like Mac OS X; en-gb) AppleWebKit/533.17.9 (KHTML, like Gecko) Version/5.0.2 Mobile/8F190 Safari/6533.18.5"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (iPod; U; CPU iPhone OS 4_3_1 like Mac OS X; zh-cn) AppleWebKit/533.17.9 (KHTML, like Gecko) Version/5.0.2 Mobile/8G4 Safari/6533.18.5"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Windows; U; Windows NT 6.0; hu-HU) AppleWebKit/533.19.4 (KHTML, like Gecko) Version/5.0.3 Safari/533.19.4"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (iPad; CPU OS 6_0 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10A5355d Safari/8536.25"})).toBeFalsy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_3) AppleWebKit/537.75.14 (KHTML, like Gecko) Version/7.0.3 Safari/7046A194A"})).toBeFalsy()


    // Firefox:
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Windows; U; Windows NT 5.1; pl; rv:1.8.1.1) Gecko/20061204 Mozilla/5.0 (X11; U; Linux i686; fr; rv:1.8.1) Gecko/20060918 Firefox/2.0b2"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (X11; U; Linux i686; de-DE; rv:1.7.13) Gecko/20060418 Firefox/1.0.8 (Ubuntu package 1.0.8)"})).toBeTruthy()
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:101.0) Gecko/20100101 Firefox/101.0"})).toBeFalsy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Microsoft Windows NT 6.2.9200.0); rv:22.0) Gecko/20130405 Firefox/22.0"})).toBeFalsy();


    // Opera:
    expect(browserMightNotSupportCORS({userAgent: "Opera/4.02 (Windows 98; U) [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; en) Opera"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/5.11 (Windows 98; U) [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 5.0; Windows NT 4.0) Opera 5.12 [de]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 5.0; Windows XP) Opera 6.0 [de]"})).toBeTruthy();

    expect(browserMightNotSupportCORS({userAgent: "Opera/6.0 (Windows 2000; U) [de]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/6.04 (Windows 2000; U) [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 5.0; Windows XP) Opera 6.04 [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/7.54 (Windows NT 5.0; U) [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1) Opera 7.54 [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1) Opera 7.54u1 [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 6.0; Windows 98) Opera 7.54u1 [en]"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux i686; U; en; rv:1.9.1.6) Gecko/20091201 Firefox/3.5.6 Opera 10.51"})).toBeTruthy();

    expect(browserMightNotSupportCORS({userAgent: "Opera/10.60 (Windows NT 5.1; U; zh-cn) Presto/2.6.30 Version/10.60"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.0; ja) Opera 11.00"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/9.80 (Windows NT 6.1; U; fi) Presto/2.7.62 Version/11.00"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/9.80 (Macintosh; Intel Mac OS X 10.6.8; U; fr) Presto/2.9.168 Version/11.52"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/9.80 (Windows NT 5.1; U; zh-sg) Presto/2.9.181 Version/12.00"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Opera/9.80 (X11; Linux i686; Ubuntu/14.10) Presto/2.12.388 Version/12.16.2"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Windows NT 5.1) Gecko/20100101 Firefox/14.0 Opera/12.0"})).toBeFalsy();

    expect(browserMightNotSupportCORS({userAgent: "Mozilla/1.22 (compatible; MSIE 2.0; Windows 95)"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 5.0; Windows NT; DigExt; YComp 5.0.2.5)"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 5.21; Mac_PowerPC)"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (compatible; MSIE 8.0; Windows NT 6.0; Trident/4.0; .NET CLR 2.7.58687; SLCC2; Media Center PC 5.0; Zune 3.4; Tablet PC 3.6; InfoPath.3)"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/4.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/5.0)"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (compatible, MSIE 11, Windows NT 6.3; Trident/7.0; rv:11.0) like Gecko"})).toBeFalsy();


    // Android Browser (AOSP):

    expect(browserMightNotSupportCORS({userAgent: "mozilla/5.0 (X11; Linux x86_64) AppleWebKit/534.24 (KHTML, like Gecko) Chrome/11.0.696.34 Safari/534.24"})).toBeTruthy();

    // Taken from here: https://stackoverflow.com/questions/14403766/how-to-detect-the-stock-android-browser
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 4.0.3; ko-kr; LG-L160L Build/IML74K) AppleWebkit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 4.0.3; de-ch; HTC Sensation Build/IML74K) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3; en-us) AppleWebKit/999+ (KHTML, like Gecko) Safari/999.9"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.5; zh-cn; HTC_IncredibleS_S710e Build/GRJ90) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.5; en-us; HTC Vision Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.4; fr-fr; HTC Desire Build/GRJ22) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.4; en-us; T-Mobile myTouch 3G Slide Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; zh-tw; HTC_Pyramid Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; zh-tw; HTC_Pyramid Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; zh-tw; HTC Pyramid Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; ko-kr; LG-LU3000 Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; en-us; HTC_DesireS_S510e Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; en-us; HTC_DesireS_S510e Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; de-de; HTC Desire Build/GRI40) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.3.3; de-ch; HTC Desire Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.2; fr-lu; HTC Legend Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.2; en-sa; HTC_DesireHD_A9191 Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.2.1; fr-fr; HTC_DesireZ_A7272 Build/FRG83D) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.2.1; en-gb; HTC_DesireZ_A7272 Build/FRG83D) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.2.1; en-ca; LG-P505R Build/FRG83) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.2.1; de-de; HTC_Wildfire_A3333 Build/FRG83D) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 2.1-update1; es-mx; SonyEricssonE10a Build/2.0.A.0.504) AppleWebKit/530.17 (KHTML, like Gecko) Version/4.0 Mobile Safari/530.17"})).toBeTruthy();
    expect(browserMightNotSupportCORS({userAgent: "Mozilla/5.0 (Linux; U; Android 1.6; ar-us; SonyEricssonX10i Build/R2BA026) AppleWebKit/528.5+ (KHTML, like Gecko) Version/3.1.2 Mobile Safari/525.20.1"})).toBeTruthy();

});

