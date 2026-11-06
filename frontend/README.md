# Bookshelf frontend (React + Tailwind CSS)

Storefront for the IBM BOB CAPSTONE Books Project. It talks only to the API described in
[`../api/openapi.yaml`](../api/openapi.yaml).

## Pages

| Route | Page |
|-------|------|
| `/login` | Sign in or create an account (client-side validation, server errors shown, open-redirect-safe return path) |
| `/` | Landing page: hero, shop by category, **Recommended for you**, new and noteworthy |
| `/books` | Catalogue: **category selector**, **brand browser**, delivery filter, sort, search, paged **product grid** with a **tentative delivery date tag** on every card |
| `/books/:id` | Product detail with **related products** |
| `/basket` | Basket, **address selection**, **credit/debit card selector**, **gift-points redemption toggle**, live totals |
| `/orders` | Order history (sign-in required): a prominent **Buy In Again** button per order and **Cancel order** within 48 hours |

## Run it

Needs Node.js `^22.22.2` or `>=24` and the backend running on `127.0.0.1:8080`
(see [`../backend/README.md`](../backend/README.md)).

```bash
cd frontend
npm install
npm run dev        # http://127.0.0.1:5173, proxies /api to the backend
npm test           # 37 component and unit tests (Vitest + Testing Library)
npm run lint
npm run build      # production bundle in dist/
```

Set `API_TARGET` (see `.env.example`) if the backend is not on `http://127.0.0.1:8080`.

### Try the whole flow locally

1. Start the backend with `PAYMENT_PROVIDER=mock` and `REQUIRE_EMAIL_VERIFICATION=false`.
2. Open the app and **Create an account**. The seeded users have placeholder password hashes, so
   register a new account rather than signing in as them.
3. Add books, go to the basket, choose an address, pick a **test card** and pay.
4. Open **My orders** to try Buy In Again and cancellation.

Gift points are earned by the backend on eligible orders. 1 point is worth 1 cent and can pay for
books only, not shipping or tax.

## Design decisions

- **Backend owns the rules.** Prices, delivery dates, the cancellation window and gift-point limits
  come from the API. The UI shows them and never decides them. Money stays a decimal string, and the few
  sums the page does (the gift-points discount) use whole cents.
- **No card data in the browser.** The card selector chooses Credit or Debit and a payment **token**.
  There is no card-number, expiry or CVV field, and the API would reject them. For this training project
  a list of **test cards** stands in for a payment provider's hosted fields (Stripe Elements,
  Adyen Drop-in, ...). To go live, mount the provider's fields in `CardPicker`
  (`src/components/CheckoutParts.jsx`) and pass its token on.
- **Safe to retry payments.** Each distinct payment request gets one `Idempotency-Key`, so a double
  click or a retry after a dropped connection cannot charge twice.
- **Token handling.** The 15-minute access token is kept in memory and mirrored to `sessionStorage`
  (cleared when the tab closes), never in `localStorage` or URLs. React escapes all rendered text and
  the app never injects raw HTML. A `401` signs the user out everywhere in the UI.
- **Loopback only.** The dev and preview servers bind to `127.0.0.1`. Calls go to same-origin `/api`,
  so there is no CORS configuration. In production serve the built `dist/` and the API behind one
  TLS 1.2+ reverse proxy.
- **Accessible by default.** Labelled form fields with linked errors, `role="alert"` and
  `role="status"` for messages, a skip link, keyboard-operable controls, and delivery tags that use
  words, not colour alone.

## Layout

```
src/
  api/client.js          fetch wrapper + one function per API operation
  context/               AuthContext, BasketContext
  components/            Layout, ui primitives, ProductCard, CheckoutParts
  lib/                   format helpers (money, dates, delivery labels), useAsync
  pages/                 one file per route
test/                    Vitest + Testing Library (API calls are mocked, no network)
```
