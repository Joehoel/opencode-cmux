# cmux Browser Automation

Use `cmux browser` to automate browser surfaces inside cmux.

## 1) Open and target a browser surface

```bash
cmux browser open https://example.com
cmux browser open-split https://example.com
cmux browser identify
cmux browser identify --surface surface:7
```

Targeting forms are equivalent:

```bash
cmux browser surface:7 url
cmux browser --surface surface:7 url
```

## 2) Navigation

```bash
cmux browser surface:7 navigate https://example.org/docs --snapshot-after
cmux browser surface:7 back
cmux browser surface:7 forward
cmux browser surface:7 reload --snapshot-after
cmux browser surface:7 url
```

## 3) Wait for app readiness

```bash
cmux browser surface:7 wait --load-state complete --timeout-ms 15000
cmux browser surface:7 wait --selector "#checkout" --timeout-ms 10000
cmux browser surface:7 wait --text "Order confirmed"
cmux browser surface:7 wait --url-contains "/dashboard"
cmux browser surface:7 wait --function "window.__appReady === true"
```

## 4) Inspect page state

```bash
cmux browser surface:7 snapshot --interactive --compact
cmux browser surface:7 snapshot --selector "main" --max-depth 5
cmux browser surface:7 get title
cmux browser surface:7 get url
cmux browser surface:7 get text "h1"
cmux browser surface:7 screenshot --out /tmp/page.png
```

## 5) Interact with UI elements

```bash
cmux browser surface:7 click "button[type='submit']" --snapshot-after
cmux browser surface:7 dblclick ".item-row"
cmux browser surface:7 hover "#menu"
cmux browser surface:7 focus "#email"

cmux browser surface:7 fill "#email" --text "dev@example.com"
cmux browser surface:7 fill "#password" --text "$PASSWORD"
cmux browser surface:7 type "#search" "cmux"
cmux browser surface:7 press Enter
cmux browser surface:7 select "#region" "us-east"
```

## 6) Assertions and locators

```bash
cmux browser surface:7 is visible "#dashboard"
cmux browser surface:7 is enabled "button[type='submit']"
cmux browser surface:7 is checked "#terms"

cmux browser surface:7 find role button --name "Continue"
cmux browser surface:7 find text "Order confirmed"
cmux browser surface:7 find label "Email"
cmux browser surface:7 find testid "save-btn"
```

## 7) Console, errors, and debugging

```bash
cmux browser surface:7 console list
cmux browser surface:7 errors list
cmux browser surface:7 screenshot --out /tmp/failure.png
cmux browser surface:7 snapshot --interactive --compact
```

## 8) Cookies, storage, and session persistence

```bash
cmux browser surface:7 cookies get
cmux browser surface:7 cookies set session_id abc123 --domain example.com --path /
cmux browser surface:7 cookies clear --name session_id

cmux browser surface:7 storage local set theme dark
cmux browser surface:7 storage local get theme
cmux browser surface:7 storage session set flow onboarding

cmux browser surface:7 state save /tmp/session.json
cmux browser surface:7 state load /tmp/session.json
```

## 9) Tabs, frames, dialogs, downloads

```bash
cmux browser surface:7 tab list
cmux browser surface:7 tab new https://example.com/pricing
cmux browser surface:7 tab switch 1
cmux browser surface:7 tab close

cmux browser surface:7 frame "iframe[name='checkout']"
cmux browser surface:7 click "#pay-now"
cmux browser surface:7 frame main

cmux browser surface:7 dialog accept
cmux browser surface:7 dialog dismiss

cmux browser surface:7 click "a#download-report"
cmux browser surface:7 download --path /tmp/report.csv --timeout-ms 30000
```

## Reliable loop for agents

For robust automation, keep this sequence:

1. `identify` target surface
2. `wait` for load state or selector
3. `snapshot --interactive --compact`
4. perform one action (`click`, `fill`, etc.)
5. validate with `is ...`, `get ...`, or another `snapshot`
6. collect artifacts (`console list`, `errors list`, `screenshot`) on failure
