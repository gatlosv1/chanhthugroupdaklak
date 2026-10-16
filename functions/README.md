# Firebase Functions for Zapier integration

## 1) Deploy functions

```bash
cd functions
npm install
firebase login
firebase deploy --only "functions" --project quanlynlchanhthu
```

## 2) Set up the real Gmail sender account

Use a dedicated Gmail sending account, not the admin login account.

1. Open the Gmail account you want to use for sending reports.
2. Enable 2-Step Verification.
3. Create an App Password.
4. Set it in Firebase Functions:

```bash
firebase functions:config:set \
  gmail.user="report.sender@gmail.com" \
  gmail.pass="abcd-efgh-ijkl-mnop"
```

You can also set the Zapier secret:

```bash
firebase functions:config:set zapier.secret="myStrongZapierSecret123"
```

Then the function uses:

```js
functions.config().gmail.user
functions.config().gmail.pass
functions.config().zapier.secret
```

## 2) Your webhook endpoint

After deploy, the function URL will look like:

```text
https://asia-southeast1-<project-id>.cloudfunctions.net/zapierWebhook
```

Use this in Zapier as a webhook action.

Headers:

```http
Authorization: Bearer replace-with-your-secret
Content-Type: application/json
```

Example payload:

```json
{
  "eventType": "production_created",
  "data": {
    "team": "A",
    "totalBtp": 80,
    "productionDate": "2026-09-11"
  }
}
```

## 3) Save to Firestore

The function stores incoming payloads in collection:

```text
zapierInbound
```

## 4) Send report mail endpoint

```text
https://asia-southeast1-<project-id>.cloudfunctions.net/sendProductionReport
```

Example body:

```json
{
  "recipients": ["user1@gmail.com", "user2@gmail.com"],
  "subject": "Báo cáo ngày 11/09/2026",
  "html": "<h1>Báo cáo</h1><p>Nội dung</p>",
  "reportDate": "2026-09-11"
}
```
