# Running a workshop with muan companion

A quick, practical guide for the person **instructing** a workshop — not writing code.

## 1. What is this

Muan companion turns a normal Slidev deck into a live, two-way workshop tool.
Without it, running a hands-on session means you have no idea what's
actually happening in the room: you can't tell if everyone is still on your
slide or has fallen behind, whether someone actually ran the command you just
taught or is staring at a blank terminal, or who's quietly stuck on an error
until they raise a hand (or you notice a face is not okay while walking past).
For remote or hybrid sessions, you get _none_ of that visibility at all.

With muan companion running: your slide changes sync to every participant's
browser automatically, participants can tick off each hands-on step as they
copy the command and finish it, they can flag a problem or ask a question
without interrupting you out loud, and you get a live dashboard showing all
of it — who's here, who's on track, who's stuck, and who needs help.

## 2. Before you start — two things must be running

You need two separate processes running at the same time: the **sync
server** (the backend that tracks everyone) and your **Slidev deck** (the
actual slides). Open two terminals.

```bash
# Terminal 1 — the sync server
cd packages/muan-companion-server
pnpm dev
```

```bash
# Terminal 2 — your deck (adjust path to your own deck if not using the demo)
cd demo/muan-companion
pnpm dev
```

That's it — you don't have to pick or set anything. If you don't set the two
code env vars, the server invents a fresh room code and presenter code for
you on every start, and **prints every URL and code you need** right in the
terminal: the room code, the presenter code, your dashboard URL, the exact
`?code=` value to add to your own deck URL, and the participant
join link. That's the source of truth — you don't need to memorize or write
these down separately.

Two things worth knowing about the codes:

- They're just short passwords: the **room code** is what you hand out to
  the whole room so people can join, and the **presenter code** is yours
  alone — never share it.
- An auto-generated code is different every time you restart the server. If
  you want the _same_ codes across restarts (e.g. a recurring demo), set
  them explicitly instead:
  ```bash
  SLIDEV_MUAN_COMPANION_ROOM_CODE=<pick-a-room-code> SLIDEV_MUAN_COMPANION_PRESENTER_CODE=<pick-a-presenter-code> pnpm dev
  ```
  An explicitly-set code always overrides the generated one.

## 3. The three URLs, precisely, and who uses which

### Presenter URL — you, and only you. Never share this.

```
http://localhost:3030/presenter/1?code=<presenterCode>
```

**The `?code=...` part is mandatory.** Without it, moving through
your slides will look completely normal on your own screen but will silently
**not** sync to any participant — no error message appears anywhere, on
either side. This is the single most common "why isn't this working"
problem. If participants say the slides aren't following you, the very first
thing to check is whether your presenter URL still has `?code=`
attached (it's easy to lose if you retype the URL, open a new tab from
history, etc.).

### Participant URL — share with the room

```
http://localhost:3030/1
```

(or whatever slide number you want them to start on). Participants open
this, then type their **name** and the **room code** into the join screen
that appears.

**Easier option — share the join link or QR code directly.** Open the
dashboard and look for the "Share this workshop" panel near the top: it
shows a ready-to-copy link in the form
`http://localhost:3030?roomCode=<roomCode>` plus a QR code encoding that
same link. Paste the link into your workshop's chat (Teams, Zoom, Slack —
wherever the room already is) or just leave the QR code up on your screen
for people to scan. Either way, opening that link takes a participant
straight to the join screen with the room code **already filled in** — they
still type their own name and click Join (that step is never skipped), but
they never have to ask "what was the room code again?" or mistype it. This
panel only appears once a room code is actually configured; it's hidden
otherwise.

### Dashboard URL — you, on a second screen or tab. Never share this either.

```
http://localhost:3710/dashboard?code=<presenterCode>
```

Note this is a different port (3710, the sync server) from your deck (3030).
If the `?code=` doesn't match the server's current presenter code, you get a
plain 401 "Presenter code required" page instead of the dashboard.

## 4. What you'll see on the dashboard

**Live counts row** — at a glance: how many have joined, how many are
viewing right now, how many are done with the current step (out of the
total), your current slide/step, and how many help requests "need
attention" (see below).

**Participant table** — one row per participant, plus rows for people who
have connected but haven't finished joining yet:

- **"Someone joining…" rows**: the instant a participant's browser loads the
  deck — before they've typed a name or clicked Join — a row appears for
  them, labeled anonymously with a "connecting" badge. Once they submit the
  join form, that same row updates in place to show their actual name; it
  never disappears and reappears as a separate row. This exists because the
  join screen is a client-side prompt, not a lock: someone technical enough
  to open their browser's dev tools and delete that overlay can watch your
  slides without ever typing a name or room code. That's an inherent
  limitation of how any web-based deck like this works, not something we
  can fully prevent — this feature just makes it visible to you instead of
  invisible, and gives you a way to act on it (see "Remove" below).
- **Presence**: _viewing now_ (tab open and focused), _away_ (tab open but
  backgrounded — they alt-tabbed or switched apps), or _closed_
  (disconnected — closed the tab, lost network, or never came back after a
  crash). This updates within a few seconds of the real state changing.
- **Status for the current step**: _idle_ (hasn't touched it), _copied_
  (clicked Copy on the command but hasn't clicked Done yet), or _done_.
- **Stuck warning**: if someone has been sitting on "copied" for a while
  without hitting Done, their row gets a visual nudge — a warning color
  after about a minute, and a stronger alert color after about three
  minutes. That's your cue to check in with them, even remotely.
- Joined-at time.
- **Remove**: a button on every row (joined or still-connecting) that
  disconnects that person. On their end, their browser is dropped straight
  back to the "Join the workshop" screen with a note that they were
  removed — not left staring at a frozen deck wondering what happened. For
  someone who hadn't joined, that's it — a clean removal, they never had an
  identity to come back with. For an already-joined participant, their
  record is also fully deleted: if they submit the join form again
  afterward, they start over as a brand-new participant (room code required
  again) rather than silently resuming with their old progress intact. Use
  it to clear out someone who shouldn't be there, or a stray test
  connection — not as a way to permanently ban someone, since they can
  still rejoin fresh with the room code unless you also change it.

**Help requests feed** — every problem report and question participants
send, newest/most-urgent first:

- **`kind`** distinguishes a **problem** (something's broken, urgent, may
  include a screenshot) from a **question** (just wants to ask something,
  text-only, no urgency implied).
- **Four statuses**, and this is worth understanding up front because it's
  not a simple open/closed toggle:
  - **open** — just came in, nobody's responded yet.
  - **awaiting confirmation** — you clicked "mark resolved," and the
    participant has been asked "did that actually fix it?" It is **not**
    resolved yet at this point — that's deliberate. You're proposing a fix
    worked; the participant gets the final say.
  - **resolved** — the participant confirmed it actually worked. This is
    the only state that means "actually done."
  - **reopened** — the participant said "no, I still need help," either
    from an awaiting-confirmation card or by adding more detail. This goes
    back into the "needs attention" bucket alongside open ones.
- **The composer**: each open/awaiting/reopened request has a text box with
  two actions — **Send** (just reply, doesn't change status — good for "on
  it" or answering a question without claiming it's fixed) and **Send &
  mark resolved** (sends your message _and_ moves the request to "awaiting
  confirmation"). Once a request is fully resolved, the composer disappears
  — there's nothing left to send.

## 5. What participants see and can do

- **Joining**: type a name and the room code once. After that, refreshing
  the page or closing and reopening the tab resumes them as the same
  person — they won't have to rejoin or lose their step history.
- **The synced deck**: their slides move automatically as you advance yours.
- **`<StepCommand>` steps**: a command block with a **Copy** button (marks
  them "in progress" on that step) and a **Done** button (marks it
  complete) — visible on your dashboard per participant, per step.
- **"Ask for Help" widget**: a small floating button, always available,
  with two tabs:
  - **Report a problem** — text box plus (on supported browsers, over
    `https://` or `localhost`) a "Capture screen" button that grabs one
    screenshot of their screen.
  - **Ask a question** — text-only, no screenshot option, for anything
    that isn't urgent.
- **When you resolve their request**: they get an actionable card — not a
  toast that disappears — asking "did that fix it?" with two choices:
  confirm it worked, or say they still need help (optionally adding more
  detail). It stays on their screen until they respond.

## 6. "Not you? Join as someone else"

This link appears after someone's identity is auto-resumed from browser
storage. It exists for a **shared or kiosk laptop** — say, a workshop
machine that gets handed from one attendee to the next. Since identity now
persists across closed tabs and even browser restarts, a second person
picking up that same laptop would otherwise silently inherit the first
person's name and progress. Clicking this button clears that stored identity
and shows a blank join form for the next person.

This was recently fixed so that clicking it also properly removes the old
identity from your dashboard — previously the old row could get stuck
showing as "viewing now" forever, even after the real person had switched
out.

## 7. Common problems and fixes

- **Slides don't sync to participants** → almost always the presenter URL
  is missing `?code=...`. Check it's still there — it's silent
  when wrong, no error appears.
- **Dashboard says "Presenter code required" / 401** → the `?code=` in your
  dashboard URL doesn't match whatever `SLIDEV_MUAN_COMPANION_PRESENTER_CODE`
  the server is currently running with. Copy the exact URL the server
  printed on startup rather than retyping it.
- **Server won't start, "address already in use"** → something else is
  already listening on that port — often a server process left over from an
  earlier session you forgot to stop. Find and stop it, or start this one
  with a different `PORT` env var.
- **After restarting the server mid-workshop, everyone has to rejoin** —
  all state lives in memory only and does not survive a server restart.
  This is a known, deliberate limitation for this version, not a bug —
  participants will auto-resume once they can reach the server again, but a
  server _restart_ (not just a network blip) resets its memory of who was
  there.

## 8. Where to go next

- For self-hosting or running a real workshop beyond your own laptop (not
  just `localhost`), see [`muan-companion.md`](./muan-companion.md) at the
  repo root.
- For implementation-level detail on either half of the system, see
  [`packages/muan-companion-server/README.md`](./packages/muan-companion-server/README.md)
  (the sync server) and
  [`packages/addon-muan-companion/README.md`](./packages/addon-muan-companion/README.md)
  (the Slidev addon).
