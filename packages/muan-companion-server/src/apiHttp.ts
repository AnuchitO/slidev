import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'

/**
 * The four things every JSON `/api/*` route in this package needs and nothing
 * else: write a JSON response, read the admin credential off a request, read a
 * size-capped body, and parse that body into a plain object.
 *
 * Extracted (plan 032c) rather than copied. All four started life as private
 * helpers inside `registrationRoutes.ts` (plan 032d), and 032c's deck-launch
 * routes need the *same* semantics — in particular the same header-or-query
 * admin-code convention and the same bounded-while-reading body limit. Two
 * copies of a credential reader is precisely the shape in which one of them
 * quietly stops matching the other: a future change that, say, starts
 * accepting a second header name would land on one route's copy and not the
 * other's, and the divergence would be invisible until someone diffed two
 * files nobody has a reason to read together.
 *
 * Nothing about the behavior of any of these changed in the extraction. The
 * only generalization is `readBody`'s byte cap, which is now a parameter
 * instead of a module constant, because the two callers have genuinely
 * different bodies to bound (see each route module's own constant).
 */

/**
 * The name of the request header carrying the cross-room admin code
 * (`adminAuth.ts`).
 *
 * A header is offered *alongside* the `?code=` query param
 * `requireDashboardCode`/`requireAdminCode` already use, rather than replacing
 * it, because these JSON routes have a different caller than `/dashboard` and
 * `/home` do. Those are URLs an operator navigates a browser to, so the
 * credential has to live in the URL — there is nowhere else to put it. These
 * are `fetch`/`curl` calls, where a header is the better carrier: query
 * strings land in access logs, proxy logs, browser history, and `Referer`
 * headers, none of which a long-lived process-wide admin code should be
 * sprinkled through. The query param is still accepted so a plain
 * `curl "$URL/api/connect-key?code=..."` works with no flags, matching these
 * endpoints' requirement to be usable without any UI.
 */
export const ADMIN_CODE_HEADER = 'x-muan-companion-admin-code'

export function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/**
 * Reads the admin credential off a request — header first (see
 * `ADMIN_CODE_HEADER`), `?code=` query param as the curl-friendly fallback.
 * Returns `undefined` when neither is present, which `isValidAdminCode`
 * rejects.
 *
 * A duplicated header (Node joins repeats into a comma-separated string, or
 * hands back an array) is read as-is and will simply fail the constant-time
 * compare — no attempt to pick "the right one" out of an ambiguous request.
 */
export function suppliedAdminCode(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers[ADMIN_CODE_HEADER]
  if (typeof header === 'string')
    return header
  if (Array.isArray(header))
    return header.join(',')
  return url.searchParams.get('code') ?? undefined
}

/**
 * Reads a request body as UTF-8 text, refusing anything over `maxBytes`.
 * Resolves `undefined` on any failure (too large, transport error) — callers
 * treat that identically to "unparseable", so no failure mode here becomes a
 * distinguishable response.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    function settle(value: string | undefined) {
      if (settled)
        return
      settled = true
      resolve(value)
    }

    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        // Over the cap: drop everything buffered so far and stop accumulating,
        // so allocation is genuinely bounded by `maxBytes` and not merely
        // reported on afterwards.
        //
        // Then `resume()` — drain and discard the rest — rather than
        // `destroy()`. Destroying the request here tears the socket down
        // before the caller has written its rejection, so the client sees a
        // connection reset instead of the uniform rejection every other
        // failure produces; that difference is itself a distinguishable
        // signal. Draining is the same treatment `screenshotUpload.ts` gives an
        // unsupported file part, and it costs nothing: nothing is buffered, and
        // Node closes the connection itself once the response ends without the
        // request having been fully consumed.
        chunks.length = 0
        settle(undefined)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => settle(undefined))
    req.on('aborted', () => settle(undefined))
  })
}

/**
 * Parses a request body into a plain JSON object, or `undefined` if it is
 * anything else at all — missing, unparseable, `null`, an array, or a bare
 * scalar.
 *
 * Strict about the *container* only; each route still checks its own fields'
 * types. `JSON.parse` will happily hand back a number, an array, `null`, or an
 * object whose fields are objects, and every route in this package treats
 * untrusted input from a caller who has not yet proven they are the presenter
 * of anything as something to check to its exact expected shape rather than
 * coerce downstream.
 */
export function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined)
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return undefined
  return parsed as Record<string, unknown>
}
