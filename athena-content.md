# Athena: website and app content

Companion to `athena.md`. The UI layout comes from Saaspo references; this file is the words. Everything here is plain text you can paste into the components.

Rules for using it:
- **No invented numbers.** Anything in `[FILL AFTER BENCHMARK]` stays a placeholder until the real receipts-based results exist. Never ship an unfilled placeholder.
- Costs are always shown as dollars with up to 6 decimals, from the receipt.
- Say "verified" only when `verify_status = verified`.
- Never promise "nothing was charged" unless the call was never sent (see the error table).

---

## 1. How the web app is shaped (for picking Saaspo components)

One site, two modes:

| Mode | Route | Feels like | Saaspo component types to look for |
|---|---|---|---|
| Landing | `/` | A clean SaaS marketing page | Hero with product screenshot, logo/trust strip, 3-step "how it works", feature grid, interactive demo or cost chart, FAQ, final CTA, footer |
| App | `/app` | An agent workspace (Manus / Iris style): chat in the middle, live activity, receipts on the side | App shell with left sidebar, chat view with message cards, right-side drawer, top status/budget bar, empty states, modals |

App layout (three columns on desktop, drawers on mobile):
- **Left sidebar:** workspace, chats list, documents list, "New chat", "Upload PDF".
- **Center:** the conversation. Each assistant message is a card with answer, citations, and a footer row (model, cost, cache, receipt badge).
- **Right drawer (opens on demand):** Activity timeline for the current question, receipt details, or the PDF page viewer.
- **Top bar:** budget meter (spent / limit), kill-switch notice if on, workspace menu.

The Manus-style touch that fits Athena exactly: a **live activity timeline** under each question showing the steps from the flow (find sections, choose model, reserve budget, ask via Prune, verify receipt). Section 4 has the step labels. Technical note: because model calls are not streamed, the server returns a `trace` array (step, label, ms) with the response and for pending messages, so the timeline is real, not a fake animation.

---

## 2. Landing page copy

### Nav
Athena · How it works · Features · Use cases · FAQ · **Try Athena** (button)

### Hero
**Headline (pick one):**
1. Ask any document anything. See exactly what it cost.
2. Document answers with a price tag and a receipt.
3. AI for your documents that shows its bill.

**Subheadline:**
Athena reads a document once, then answers with only the parts that matter. Every answer shows the model used, what it cost, and a Prune receipt you can verify.

**Buttons:** Try Athena (primary) · See how it works (secondary)

**Small line under buttons:** No sign-up. Set your own spending limit. Every call goes through Prune.

### Trust strip (one line, three chips)
Every answer has a receipt · Spending checked before every call · No provider keys in our code

### Problem section
**Title:** AI on documents has four hidden problems

| Heading | Text |
|---|---|
| Cost climbs with every question | Most tools resend the whole file and the whole chat each time, so your tenth follow-up costs far more than your first. |
| You can't see what you spent | Answers come with no price and no model name. The bill arrives later. |
| Failures cost money | A timeout triggers blind retries. A loop repeats the same call. A crash makes you pay twice. |
| Trust is hard to prove | Documents can hide instructions meant to trick the model, and nobody can prove what was spent. |

### How it works
**Title:** From PDF to answer in four steps

1. **Upload.** Drop in a PDF. Text is read in your browser, so the file isn't re-processed for every question.
2. **Index.** Athena splits it into sections and remembers the page of each one.
3. **Ask.** Athena finds the relevant sections, picks a model that fits the question, and checks your budget first.
4. **Verify.** Get the answer with page citations, the cost, and a signed receipt you can check.

### Features
**Title:** Built to keep costs low and answers checkable

| Feature | Text |
|---|---|
| Chat that remembers | Follow-ups use a saved summary plus the earlier messages that matter, not the whole history. |
| Reads your PDFs | Text PDFs are read directly. Page numbers are kept for every citation. |
| Search once, ask forever | Your document is indexed one time. Later questions never reprocess the file. |
| Right-sized models | Simple lookups use an economical model. Harder questions use a stronger one. You always see which. |
| A receipt for every answer | Cost, model, cache status and a signature check, shown with the answer. |
| Budget-aware | Athena checks your allowance before each call and pauses with options instead of overspending. |
| Safe when things fail | Temporary errors retry a limited number of times. Unclear cases never retry blindly. Finished work stays saved. |

### Use cases
**Title:** One engine, many kinds of documents

- **Contracts and reports.** "What are the payment terms? Summarize section 4."
- **Invoices and bills.** "What's the total and due date? Do the line items add up?"
- *(Coming soon)* Support tickets · App reviews · Logistics emails · Course forum posts

### Proof section
**Title:** Don't take our word for it

- Every receipt is signed by Prune. Athena checks the signature and shows the result next to the answer.
- Export all your receipts and verify them yourself.
- **Results [FILL AFTER BENCHMARK]:** Athena answers cost on average **[X]%** less than sending the whole document every time, and the cost of question 10 stays within **[Y]%** of question 1. Measured on **[N]** questions across **[M]** documents. Accuracy: **[Z]%** vs **[W]%** for the baseline.
- *Chart: cost per answer, questions 1 to 10, Athena vs baseline.*

### Safety section
**Title:** Safe by design

- Document text is treated as data, never as instructions.
- Provider keys never touch our code; they live in Prune's vault.
- A spending limit is enforced twice: by Athena before the call and by Prune on its side.
- When a call's billing is uncertain, we count the estimate against your allowance and ask you before retrying.

### FAQ
1. **Why not just use ChatGPT or Claude with a PDF?** Those don't show the cost of each answer, don't enforce a budget before the call, and don't give you a signed receipt. Athena is for people who want cost control and proof.
2. **How do you know the savings are real?** Cost comes only from signed Prune receipts. We compare Athena with two baselines on the same questions and publish the results.
3. **What if the AI service is down?** Athena stops safely. It never makes up an answer or bills you twice, and your documents stay saved. You can retry when it's back.
4. **What about hidden instructions inside a PDF?** The document is fenced off as untrusted text, Prune's Shield is on, and we test with injected documents. We aim for "harmless", not magic.
5. **Does a summary lose information?** It can. That's why follow-ups also pull in the specific earlier messages that matter.
6. **Does it read scanned PDFs?** Not yet. Scanned pages are flagged. Reading them is on the roadmap.
7. **Is my data private?** Your workspace is separate from everyone else's, protected by a private token. You can delete any document or chat at any time.

### Final CTA
**Headline:** Ask your first question in a minute.
**Button:** Try Athena
**Line:** Free to try. You set the limit.

### Footer
Athena · Built for the FORGE "Ship It Lean" track · Powered by Prune · Privacy · How receipts work

---

## 3. App copy

### First-time (SessionBootstrap)
- Title: **Welcome to Athena**
- Text: We created a private workspace for you. Set a spending limit and upload a PDF to start.
- Default budget label: **Spending limit** (helper: "Athena will never go over this.")
- Button: **Start**

### Empty states
| Where | Title | Text | Button |
|---|---|---|---|
| No documents | No documents yet | Upload a PDF and Athena will index it for questions. | Upload a PDF |
| No chats | No chats yet | Pick a ready document to start asking. | New chat |
| Empty chat | Ask about your document | Try one of these: | (suggested questions, below) |
| Usage panel, no calls | Nothing spent yet | Your costs will appear here after the first answer. | - |

### Suggested questions
- General: "Summarize this document in five bullets." · "What are the key dates and deadlines?" · "What obligations does each side have?"
- Invoice: "What is the total and the due date?" · "List every line item." · "Do the line items add up to the total?"

### Upload (UploadPanel)
- Drop zone: **Drop a PDF here or choose a file** · helper: "Up to 25 MB and 150 pages. Text is read in your browser."
- Progress steps: Reading pages (12 of 40) → Sending text → Saving page references → Indexing sections → **Ready**
- Ready: "Ready to ask. 40 pages, 52 sections."
- Partial: "Ready, but 3 pages couldn't be read (they look scanned). Answers won't cover them."
- Failed: "We couldn't finish indexing this file. Your original PDF is saved. Try uploading again."
- Pack picker label: **What kind of document is this?** · options: General · Invoice

### Composer
- Placeholder: "Ask about your document…"
- Mode chips: Ask · Summarize · Extract fields (invoice only)
- Length toggle: **Normal answer** / **Shorter answer (cheaper)**
- Send button: **Send** · while waiting: **Working…**
- Cost hint under the box (from the estimate): "Estimated up to $0.0004"

### Activity timeline (per question, Manus style)
Question steps (label → detail example):
1. **Reading your question**
2. **Finding relevant sections** → "3 sections, pages 2 and 5"
3. **Choosing a model** → "Economy: short lookup"
4. **Reserving budget** → "Up to $0.0004"
5. **Asking through Prune** → "attempt 1 of 3" (shown only if retries happened)
6. **Verifying receipt** → "Signature valid"
7. **Done** → "$0.000412 · 1.8 s"

Document steps: **Extracting text** → **Saving page references** → **Indexing sections** → **Ready**

Retry line (shows live): "The service is busy. Trying again (2 of 3)."

### Answer card
- Footer row: `Economy · gpt-… · $0.000412 · Cache miss · ✔ Receipt verified`
  (model name comes from the response; never hard-code)
- Cache labels: **Cache hit (free)** / **Cache miss**
- Badge labels: **Receipt verified** (green) · **Verification failed** (red; tooltip: "The signature didn't match. Treat this cost as unconfirmed.") · **Verify offline** (grey; tooltip: "We couldn't check this in the browser. Use the exported file and verify.py.") · **No receipt** (amber)
- Citations: **Page 2** chips; click opens the page viewer on the right.
- Escalation note (when it happened): "First attempt didn't pass our checks, so a stronger model answered."
- Actions: Copy · Show receipt · Show activity

### Pause prompt (budget doesn't fit)
- Title: **Not enough allowance for this answer**
- Text: "This question needs about **$0.0310**. You have **$0.0120** left. Nothing has been sent."
- Buttons: **Make it shorter** · **Raise my limit** · **Cancel**
- After "Raise my limit": slider with the maximum shown. Helper: "You can raise your limit up to $[MAX]."
- Variant when Prune's own cap stopped it: "A spending limit on the service side stopped this call. You can shorten the question or try again later."

### Billing uncertain prompt
- Title: **We can't tell if this was billed**
- Text: "The connection dropped after your question was sent, so no receipt came back. We've counted the estimated **$0.0004** against your allowance to be safe."
- Buttons: **Retry once** · **Leave it**
- Footnote: "Retrying may be charged again."

### Receipt drawer
- Title: **Receipt**
- Rows: Model · Tier · Cost · Cost without Prune *(label only if the field exists)* · Cache · Tokens in / out · Attempts · Time
- Verify status block with button **Verify again**
- Link: **Copy raw receipt** · helper: "This is the exact data Prune signed."
- Note: "Costs come from the receipt, not from our estimate."

### Budget bar and settings
- Bar: **$0.0123 of $0.50 used** · tooltip: "Includes $0.0004 reserved for calls in progress."
- Settings title: **Spending limit** · helper: "Athena checks this before every call. Maximum $[MAX]."
- Save success: "Limit updated."
- Over-max error: "That's above the maximum of $[MAX] for this demo."

### Usage panel
- Title: **What you've spent**
- Cards: Total spent · Average per answer · Cache hits · Receipts verified (e.g. "18 of 18")
- Chart: **Cost per answer** (x: question number in the chat)
- Button: **Export receipts (.jsonl)** · helper: "Verify them yourself with the script in the README."

### Delete confirmations
- Document: "Delete **[filename]**? Its pages and index are removed. Chats that used it keep their messages."
- Chat: "Delete this chat? This can't be undone."

### Admin (stretch)
- Kill switch: **Pause all model calls** · status "Model calls are paused. Nothing is being sent."

---

## 4. Error messages by code

Show the title in bold and the text under it. "Retry" appears only where the plan allows it.

| Code | Title | Text | Action |
|---|---|---|---|
| `unauthorized` | Session expired | Start a new workspace to continue. | New workspace |
| `forbidden` | No access | You don't have access to this item. | - |
| `not_found` | Not found | That item may have been deleted. | Back |
| `validation_failed` | That didn't look right | Check the file or message and try again. | - |
| `conflict` | Not available right now | Refresh and try again. | Refresh |
| `payload_too_large` | File too large | Files can be up to 25 MB and 150 pages. | Choose another |
| `rate_limited` | Slow down a little | Too many requests in a short time. Wait a moment, then try again. | Try again |
| `kill_switch_on` | Athena is paused | Model calls are turned off for now. Nothing was sent. | - |
| `budget_exhausted` | Spending limit reached | Not enough allowance for this answer. | See pause options |
| `document_not_ready` | Still indexing | This document isn't ready yet. Try again in a moment. | - |
| `shield_blocked` | Request blocked | Prune's safety checks blocked this. Try rephrasing, or remove the flagged content. | - |
| `provider_auth_failed` | Service unavailable | We couldn't authenticate with the AI service. This isn't something you can fix, and we stopped instead of retrying. | - |
| `provider_unavailable` | AI service is down | We tried three times and stopped. Your documents and chats are saved. | Try again |
| `billing_uncertain` | We can't tell if this was billed | See "Billing uncertain prompt". | Retry once |
| `receipt_missing` | Answer without a receipt | We got a reply but no receipt, so we won't show it as verified. The estimated cost was counted. | Retry once |
| `internal` | Something went wrong | That one's on us. Your documents are saved. | Try again |

---

## 5. Voice and style

- Plain, specific, calm. Say what happened, what it means for the user's money, and what they can do.
- Short sentences. No hype words ("revolutionary", "magic"). No "AI-powered".
- Always show amounts in dollars; never show micro-dollars.
- Use "answer", "document", "allowance"/"spending limit". Avoid "token", "inference", "RAG" in the UI.
- Sentence case for headings and buttons.
- Honest limits are a feature: say "text PDFs only", "harmless, not blocked", "estimated" where true.

---

## 6. What to send the UI designer (Saaspo shortlist brief)

When picking references, collect three things:
1. **A landing page** with: hero + product screenshot, 3-step section, feature grid, a chart section (for the cost curve), FAQ.
2. **An app shell** with: left sidebar, central chat, right drawer, top status bar.
3. **An "agent activity" pattern** (Manus-style step list or timeline) and a **receipt / invoice-style card**.

Name the screens you need mocked, so copy and layout match: Landing · First-run welcome · Upload and indexing · Chat with answer card · Pause prompt · Receipt drawer · Usage panel · Error and empty states.
