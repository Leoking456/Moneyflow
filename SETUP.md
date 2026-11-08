# MoneyFlow – get your own Firebase config (≈5 minutes, free)

Menu names in the Firebase console occasionally move around, but the steps are the same.

1. **Create a project**
   console.firebase.google.com → *Create a project* (or *Add project*) → name it → Google Analytics isn't needed → Create.

2. **Turn on Google sign-in**
   *Build → Authentication → Get started → Sign-in method → Google → Enable* → pick a support email → Save.

3. **Authorise your website address**
   *Authentication → Settings → Authorized domains → Add domain*.
   Add the domain you host MoneyFlow on (e.g. `yourname.github.io` or `yoursite.netlify.app`).
   `localhost` is already allowed.

4. **Create the database**
   *Build → Firestore Database → Create database* → choose a location near you → start in **production mode** → Enable.

5. **Publish the security rules** (Firestore → *Rules* tab → replace everything → *Publish*):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /moneyflow/{userId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```
   This lets each signed-in user read/write only their own document.

6. **Get your config**
   *Project settings (gear icon) → General → Your apps → Web (</>) → register the app (nickname anything; skip Hosting) → copy the `firebaseConfig` values.*
   Paste them over the placeholders at the top of `script.js`.
   (A Firebase web `apiKey` is not a secret — your rules in step 5 are what protect the data.)

7. **Host it** – Google sign-in does not work when you double-click `index.html` (`file://`).
   Use GitHub Pages, Netlify, Firebase Hosting, or locally:
   `python -m http.server 8000` → open http://localhost:8000

## Check it works
Sign in; the badge in the top bar should say **Synced to Google** (green). Add a transaction and look in
*Firestore Database → Data → moneyflow → (your user id)*. If the badge turns red, click it for the exact fix.

## Moving from your old project
Your data also lives in each device's browser. On the first sign-in with the new project, whatever is on
that device is uploaded. Before switching, press **Export .txt** in Transaction history on the device with the most data —
you can **Import** that file anytime.

## .txt file format
```
# MoneyFlow export v1
[TAB] General
add | 2026-11-01 | 25.00 | Birthday money
spend | none | 3.50 | Coffee
```
`type | date | amount | description` — type is `add` or `spend`, date is `YYYY-MM-DD` or `none`. Lines starting with `#` are ignored.
- **Import (add)** merges into your data and skips exact duplicates already in the same tab.
- **Import (replace all)** wipes current tabs first (asks to confirm).
