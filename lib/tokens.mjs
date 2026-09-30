// Mac-side entry point for the signed one-click tokens. The implementation lives in
// api/_tokens.mjs so the Vercel functions verify links with exactly the same code.
import "./env.mjs";
export { mintToken, verifyToken } from "../api/_tokens.mjs";
