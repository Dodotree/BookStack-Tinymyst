import { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import { config } from "dotenv";
import { join } from "path";

config({ path: join(process.cwd(), ".env") });
const JWT_SECRET = process.env.TINYMIST_WS_SECRET ?? "dev-secret";

export type AuthToken = {
    user_id: number;
    page_id: number;
    exp: number;
    tabToken?: string;
};

export function verifyRequestToken(request: IncomingMessage): AuthToken {
    // Header remains mydomain.com
    // as long as nginx block has "proxy_set_header Host $host";
    // custom headers get stripped by some proxies
    // unless explicitly preserved
    // "proxy_set_header Sec-WebSocket-Protocol $http_sec_websocket_protocol;"
    const protocol = request.headers["x-forwarded-proto"] ?? "http";
    const url = new URL(
        request.url ?? "/",
        `${protocol}://${request.headers.host ?? "localhost"}`
    );
    const tokenParam =
        url.searchParams.get("token") || request.headers["sec-websocket-protocol"];
    console.log("Connection attempt:", {
        url: request.url,
        hasToken: !!tokenParam,
    });

    if (!tokenParam) {
        console.error("No token provided");
        throw new Error("MISSING_TOKEN");
    }

    const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
    console.log("Extracted token:", token.substring(0, 30) + "...");

    let payload: AuthToken;
    try {
        payload = verifyToken(token);
    } catch (err) {
        console.error("Invalid token during connection", err);
        throw new Error("INVALID_TOKEN", { cause: err });
    }
    payload.tabToken = url.searchParams.get("tabToken") || "";
    return payload;
}

export function verifyNewToken(token: string, pageId: number): AuthToken {
    let payload: AuthToken;
    try {
        payload = verifyToken(token);
        if (payload.page_id !== pageId) {
            throw new Error("TOKEN_PAGE_MISMATCH", {
                cause: {
                    contextPageId: pageId,
                    tokenPageId: payload.page_id,
                },
            });
        }
    } catch (err) {
        console.error("Invalid token during connection", err);
        throw new Error("INVALID_TOKEN", { cause: err });
    }
    return payload;
}

function verifyToken(token: string): AuthToken {
    try {
        console.log("Verifying token:", {
            token: token.substring(0, 20) + "...",
            secretLength: JWT_SECRET.length,
        });
        const decoded = jwt.verify(token, JWT_SECRET) as AuthToken;
        console.log("Token verified successfully:", {
            user_id: decoded.user_id,
            page_id: decoded.page_id,
            exp: decoded.exp,
        });
        return {
            user_id: Number(decoded.user_id), // "as AuthToken" still returns strings occasionally
            page_id: Number(decoded.page_id),
            exp: decoded.exp,
        };
    } catch (err) {
        console.error("Token verification failed:", err);
        throw new Error("INVALID_TOKEN", { cause: err });
    }
}
