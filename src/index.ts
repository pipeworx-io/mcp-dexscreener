interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * DEX Screener MCP — DEX price/liquidity/volume data
 *
 * Auth: none. ~300 req/min per IP.
 * Docs: https://docs.dexscreener.com/api/reference
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init ?? {}, 'DEX Screener');
  } catch (err) {
    // fetchWithTimeout already words the timeout case. Everything else — DNS
    // failure, connection refused, TLS error, "Network connection lost" — is
    // rethrown raw, and a bare `TypeError: fetch failed` names no upstream and
    // reads like a defect in Pipeworx. Say what we know: we never reached the
    // index, so this call carries NO information about the address that was
    // asked for (fleet #1579).
    const msg = err instanceof Error ? err.message : String(err);
    // A message that already carries a routing token (fetchWithTimeout's
    // `upstream_down:` timeout wording) is already correct — pass it through
    // rather than re-wrapping, which would push its token off position 0.
    if (CLASS_PREFIX_RE.test(msg)) throw err;
    // Everything reaching here is untokened, but drop defensively: this string
    // becomes a FRAGMENT inside the sentence below, where a token could never
    // route anything and would only leak to the caller.
    throw new Error(
      `upstream_down: could not reach DEX Screener at all (${dropClassPrefix(msg).slice(0, 120)}). ` +
        'No request reached their index, so this says NOTHING about whether the token, pair or chain you asked ' +
        'for exists — do not re-check your arguments on the strength of this error. Retry shortly.',
    );
  }
}

const BASE = 'https://api.dexscreener.com';
const LATEST = `${BASE}/latest/dex`;

const tools: McpToolExport['tools'] = [
  {
    name: 'get_pair',
    description: 'Pair detail (price USD/native, liquidity, 24h volume, 5m/1h/6h/24h tx counts).',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain id — ethereum | solana | bsc | polygon | arbitrum | base | …' },
        pair_address: { type: 'string', description: 'Pair / pool address' },
      },
      required: ['chain', 'pair_address'],
    },
  },
  {
    name: 'get_token',
    description: 'All trading pairs for a token address on one chain.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain id' },
        token_address: { type: 'string', description: 'Token contract address' },
      },
      required: ['chain', 'token_address'],
    },
  },
  {
    name: 'search_pairs',
    description: 'Free-text search across all DEX Screener chains for trading pairs matching a token name, symbol, or address. Returns up to 30 pairs with price USD, liquidity, 24h volume, and chain/DEX info.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'latest_token_profiles',
    description: 'Newest token profiles created (cross-chain).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'latest_boosted_tokens',
    description: 'Tokens being actively promoted on DEX Screener.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'token_boosts_top',
    description: 'Most-boosted tokens, optionally filtered to a chain / token.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string' },
        token: { type: 'string', description: 'Token address (chain required if passed)' },
      },
    },
  },
  {
    name: 'dexscreener_screener',
    description:
      "A filterable screen for new/trending tokens on one chain (default solana), by liquidity, volume and market cap — composes DEX Screener's promoted-token lists (latest_token_profiles + latest_boosted_tokens, which is what DEX Screener itself surfaces as \"new/trending\") with per-token pool detail (same data as get_token) to filter and rank. Answers 'trending solana memecoins with liquidity over $1000 and market cap under $1M', 'new solana pairs with high volume', 'recent tokens on solana above a liquidity floor'. NOT DEX Screener's full new-pair firehose (their public API has no such endpoint) — it screens the tokens currently being promoted/profiled on DEX Screener, which is the same 'new/trending' surface a human sees on their homepage. Each matching pool includes price, liquidity USD, 24h volume, market cap/FDV, and when the pool was created. Checks up to 30 candidate tokens per call.",
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Chain id, default "solana". Any DEX Screener chain id works (ethereum, bsc, base, …).' },
        min_liquidity_usd: { type: 'number', description: 'Minimum pool liquidity in USD. Default 0 (no floor).' },
        max_market_cap_usd: { type: 'number', description: 'Maximum market cap / FDV in USD. Default: no ceiling.' },
        min_volume_24h_usd: { type: 'number', description: '24h volume floor in USD. Default 0 (no floor).' },
        sort: { type: 'string', enum: ['volume', 'liquidity', 'recent'], description: 'Sort by 24h volume (default), pool liquidity, or pool creation time (newest first).' },
        limit: { type: 'number', description: 'Max pools to return, 1-50 (default 20).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_pair': {
      const chain = reqStr(args, 'chain', '"ethereum"');
      const pairAddress = reqStr(args, 'pair_address', '"0x..."');
      const body = await dsGet<{ pairs?: unknown[] | null; pair?: unknown | null }>(
        `${LATEST}/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`,
      );
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      // A pair DEX Screener does not index comes back as HTTP 200 with
      // `{"pairs":null,"pair":null}` — the index answered, and the answer was
      // nothing. That, and only that, is a genuine lookup miss — a confirmed
      // empty result from a valid query, not a failure. Returned as a clean
      // zero-count success (not thrown) per docs/error-taxonomy-audit.md
      // Defect C: throwing collapsed this into the same wire shape as an
      // actual bad argument. `pair_count: 0` is the honest signal; `not_found`
      // and `note` say why, for a caller reading the body without inspecting
      // the count.
      if (pairs.length === 0) {
        return {
          chain, pair_address: pairAddress, pair_count: 0, pairs: [],
          not_found: true,
          note: `DEX Screener answered, and it indexes no pair at ${pairAddress} on chain "${chain}". This is the index reporting an empty result, not a failure to reach it — the pool may never have been indexed, or the chain id may not match the address (an unrecognised chain id also returns empty). Use search_pairs to find the pair address DEX Screener knows.`,
        };
      }
      return { chain, pair_address: pairAddress, pair_count: pairs.length, pairs };
    }
    case 'get_token': {
      const chain = reqStr(args, 'chain', '"ethereum"');
      const tokenAddress = reqStr(args, 'token_address', '"0x..."');
      // `/latest/dex/tokens/{address}/{chain}` was never a DEX Screener route.
      // Express answered `Cannot GET …` with a 404 for EVERY input, including
      // WETH and USDT, and this pack mapped that 404 to "no pairs for that
      // address" — so the tool was 100% broken while telling callers their own
      // address was wrong (fleet #1579).
      //
      // `/token-pairs/v1/{chainId}/{tokenAddress}` is the chain-scoped route
      // that matches this tool's promise. NOT `/tokens/v1/{chainId}/{addr}`,
      // which is the obvious-looking one and answers with a SINGLE pool:
      // measured 2026-09-08, WETH on ethereum returns 1 pair there and 30 here.
      // Both are 200s with a plausible array, so picking the wrong one is a
      // silent 97% data loss, not an error.
      const pairs = await dsGet<unknown[]>(
        `${BASE}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}`,
      );
      const list = Array.isArray(pairs) ? pairs : [];
      // Confirmed empty, not a failure — same reasoning as get_pair above.
      // Returned as a clean zero-count success rather than thrown.
      if (list.length === 0) {
        return {
          chain, token_address: tokenAddress, pair_count: 0, pairs: [],
          not_found: true,
          note: `DEX Screener answered, and it has no pairs for ${tokenAddress} on chain "${chain}". A 200 with an empty list is the index saying it holds nothing for that pair of arguments — it does NOT distinguish between a token that has never traded on a DEX they cover, a wrong contract address, and a chain id they do not recognise (all three return empty). Try search_pairs with the token symbol to see which chain it actually trades on.`,
        };
      }
      return { chain, token_address: tokenAddress, pair_count: list.length, pairs: list };
    }
    case 'search_pairs': {
      const query = reqStr(args, 'query', '"WETH"');
      const body = await dsGet<{ pairs?: unknown[] | null }>(`${LATEST}/search?q=${encodeURIComponent(query)}`);
      const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
      // Confirmed empty — the search ran and matched nothing, which is a
      // clean answer, not an error. Returned rather than thrown (fleet #1797 /
      // docs/error-taxonomy-audit.md Defect C — this exact tool was the audit's
      // worked example of the throw-collapses-empty-into-user_error bug).
      if (pairs.length === 0) {
        return {
          query, pair_count: 0, pairs: [],
          not_found: true,
          note: `DEX Screener's search returned no pairs for "${query}". The search ran and matched nothing — it matches token names, symbols and addresses, so a symbol with no match usually means the token does not trade on a DEX they cover.`,
        };
      }
      return { query, pair_count: pairs.length, pairs };
    }
    case 'latest_token_profiles':
      return { profiles: await dsList(`${BASE}/token-profiles/latest/v1`, 'token profiles') };
    case 'latest_boosted_tokens':
      return { boosts: await dsList(`${BASE}/token-boosts/latest/v1`, 'boosted tokens') };
    case 'token_boosts_top': {
      // `/token-boosts/top/v1/{chain}/{token}` is not a DEX Screener route
      // either — same `Cannot GET` 404 as get_token had, for every argument
      // pair. The endpoint takes no path filter, so filter its result here
      // (fleet #1579).
      const all = await dsList(`${BASE}/token-boosts/top/v1`, 'top boosted tokens');
      const chain = typeof args.chain === 'string' ? args.chain.trim() : '';
      const token = typeof args.token === 'string' ? args.token.trim() : '';
      if (!chain && !token) return { boosts: all, boost_count: all.length, filtered: false };
      if (token && !chain) {
        throw new Error('user_error: pass `chain` alongside `token` — boost entries are keyed by (chainId, tokenAddress).');
      }
      const matched = all.filter((b) => {
        const row = b as { chainId?: unknown; tokenAddress?: unknown };
        if (String(row.chainId ?? '').toLowerCase() !== chain.toLowerCase()) return false;
        if (!token) return true;
        return String(row.tokenAddress ?? '').toLowerCase() === token.toLowerCase();
      });
      // Confirmed empty — the filter ran against the live list and matched
      // nothing. Returned as a clean zero-count success rather than thrown.
      if (matched.length === 0) {
        return {
          chain, token: token || undefined, boosts: [], boost_count: 0, filtered: true,
          not_found: true,
          note: `Nothing matching chain "${chain}"${token ? ` and token ${token}` : ''} is in DEX Screener's current top-boosted list (${all.length} entries checked across all chains). The list is a live promotional ranking that turns over constantly — absence from it says nothing about whether the token trades.`,
        };
      }
      return { chain, token: token || undefined, boosts: matched, boost_count: matched.length, filtered: true };
    }
    case 'dexscreener_screener':
      return screener(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

interface ScreenerPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
}

async function screener(args: Record<string, unknown>) {
  const chain = (typeof args.chain === 'string' && args.chain.trim() ? args.chain.trim() : 'solana').toLowerCase();
  const minLiquidity = Number(args.min_liquidity_usd ?? 0);
  const maxMcap = args.max_market_cap_usd != null ? Number(args.max_market_cap_usd) : Infinity;
  const minVolume = Number(args.min_volume_24h_usd ?? 0);
  const sort = typeof args.sort === 'string' ? args.sort : 'volume';
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50);

  // DEX Screener's public API has no "new pairs on chain X" endpoint. The
  // closest thing it exposes is what it itself promotes as new/trending —
  // the profile and boost lists — so this screens THOSE, then pulls each
  // candidate's real pool numbers to filter/sort by. Cap candidates so one
  // tool call stays inside the Worker's execution budget.
  const [profiles, boosts] = await Promise.all([
    dsList(`${BASE}/token-profiles/latest/v1`, 'token profiles').catch(() => [] as unknown[]),
    dsList(`${BASE}/token-boosts/latest/v1`, 'boosted tokens').catch(() => [] as unknown[]),
  ]);
  const candidates = new Map<string, string>(); // tokenAddress -> chainId (lowercased key)
  for (const item of [...profiles, ...boosts]) {
    const row = item as { chainId?: unknown; tokenAddress?: unknown };
    const rowChain = String(row.chainId ?? '').toLowerCase();
    const addr = String(row.tokenAddress ?? '');
    if (rowChain !== chain || !addr) continue;
    candidates.set(addr.toLowerCase(), addr);
  }
  const addrs = Array.from(candidates.values()).slice(0, 30);
  if (addrs.length === 0) {
    return {
      chain, checked: 0, matched: 0, pairs: [],
      not_found: true,
      note: `DEX Screener's current profile/boost lists have no ${chain} tokens to screen (checked 0 candidates). Those lists turn over constantly — retry shortly, or use search_pairs for a specific token instead of a broad screen.`,
    };
  }

  const perToken = await Promise.all(
    addrs.map(async (addr) => {
      try {
        const pairs = await dsGet<ScreenerPair[]>(`${BASE}/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(addr)}`);
        return Array.isArray(pairs) ? pairs : [];
      } catch {
        return [] as ScreenerPair[];
      }
    }),
  );
  const allPairs = perToken.flat();

  const matched = allPairs.filter((p) => {
    const liq = p.liquidity?.usd ?? 0;
    const vol = p.volume?.h24 ?? 0;
    const mcap = p.marketCap ?? p.fdv ?? 0;
    return liq >= minLiquidity && vol >= minVolume && mcap <= maxMcap;
  });

  matched.sort((a, b) => {
    if (sort === 'liquidity') return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
    if (sort === 'recent') return (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0);
    return (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0);
  });

  const out = matched.slice(0, limit).map((p) => ({
    chain: p.chainId ?? chain,
    dex: p.dexId ?? null,
    pair_address: p.pairAddress ?? null,
    base_token: p.baseToken ?? null,
    quote_token: p.quoteToken ?? null,
    price_usd: p.priceUsd ?? null,
    liquidity_usd: p.liquidity?.usd ?? null,
    volume_24h_usd: p.volume?.h24 ?? null,
    market_cap_usd: p.marketCap ?? p.fdv ?? null,
    pair_created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
    url: p.url ?? null,
  }));

  if (out.length === 0) {
    return {
      chain, checked: addrs.length, pools_seen: allPairs.length, matched: 0, pairs: [],
      not_found: true,
      note: `Checked ${addrs.length} promoted ${chain} tokens (${allPairs.length} pools total) and none met the filter (liquidity>=$${minLiquidity}, volume24h>=$${minVolume}, mcap<=${Number.isFinite(maxMcap) ? '$' + maxMcap : 'no cap'}). Loosen the thresholds, or this is a thin moment for the promoted-token list.`,
    };
  }

  return {
    chain,
    checked: addrs.length,
    pools_seen: allPairs.length,
    matched: matched.length,
    returned: out.length,
    filters: { min_liquidity_usd: minLiquidity, max_market_cap_usd: Number.isFinite(maxMcap) ? maxMcap : null, min_volume_24h_usd: minVolume },
    sort,
    note: 'Screens DEX Screener\'s own promoted/profiled token lists (its "new/trending" surface), not the full chain firehose — their public API has no broader new-pair endpoint.',
    pairs: out,
  };
}

/**
 * One GET, and one rule about what an error is allowed to claim.
 *
 * The rule exists because this pack broke it: a 404 was mapped, in every case,
 * to "DEX Screener has no pairs for that address … this is a lookup miss, not
 * an outage — check the chain and the exact contract address." That sentence
 * asserts a caller-side cause. It was wrong for every call get_token ever
 * served, and it was persuasive enough that callers re-checked correct
 * addresses and concluded a real token was not indexed (fleet #1579).
 *
 * Measured 2026-09-08 against the live API: when DEX Screener genuinely has
 * nothing for an argument it answers **HTTP 200 with an empty list** —
 * `/tokens/v1/…` returns `[]`, `/latest/dex/pairs/…` returns
 * `{"pairs":null}`. It does not 404. So a 404 from this API is a route or
 * availability problem on our side of the question, never evidence about the
 * address, and the emptiness check belongs at the call site where the shape is
 * known. `dsGet` therefore never says "not found" — it only reports transport.
 */
async function dsGet<T>(url: string): Promise<T> {
  const res = await pwFetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'pipeworx-mcp-dexscreener/1.0 (+https://pipeworx.io)',
    },
  });
  if (res.status === 429) throw new Error('upstream_throttled: DEX Screener rate-limit (HTTP 429) — retry shortly.');
  if (!res.ok) {
    const detail = await httpErrorMessage(res, 'DEX Screener');
    throw new Error(
      `upstream_down: ${detail} for ${new URL(url).pathname}. ` +
        'That is an upstream or routing failure, NOT a statement about the arguments you passed: when DEX Screener ' +
        'has no data for an address it answers HTTP 200 with an empty list, never an error status. Re-checking the ' +
        'address will not change this — retry, and report it if it persists.',
    );
  }
  return parseJson<T>(res, 'DEX Screener');
}

/** The three list endpoints all return a bare JSON array. */
async function dsList(url: string, what: string): Promise<unknown[]> {
  const body = await dsGet<unknown>(url);
  if (!Array.isArray(body)) {
    throw new Error(
      `upstream_down: DEX Screener returned an unexpected shape for ${what} (expected a JSON array). ` +
        'Their response format has changed or a proxy answered in their place — nothing about the request causes this.',
    );
  }
  return body;
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
