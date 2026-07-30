# Xpensego

Xpensego turns financial records supplied by a person into a trustworthy, categorized ledger that can be reviewed and queried across messaging and web surfaces.

## People and access

**User**:
A person who owns their Xpensego data and controls the messaging identities linked to it.
_Avoid_: Customer, Telegram user

**User Account**:
The authenticated product relationship through which a user manages their profile, settings, ledger, and linked messaging identities.
_Avoid_: Bank account, ledger

**Surface**:
A user-facing place where someone interacts with Xpensego. The initial surfaces are the web application and Telegram; WhatsApp is added later.
_Avoid_: Channel when referring to web and messaging together

**Messaging Channel**:
An external messaging platform through which a user interacts with Xpensego, initially Telegram and later WhatsApp.
_Avoid_: Surface, frontend

**Channel Identity**:
A user's platform identity within one messaging channel, linked to exactly one Xpensego user account.
_Avoid_: Channel user, Telegram account, WhatsApp account

**Consent**:
A user's recorded permission for a specific kind of data processing or proactive notification.
_Avoid_: Preference, assumption

## Money records

**Ledger**:
An isolated collection of transactions. In the first release, each ledger has one owner; shared access is a later experiment.
_Avoid_: User account, bank account, wallet, database

**Transaction**:
A normalized record of money spent or received by a ledger.
_Avoid_: Entry, payment

**Source Record**:
The immutable text or file row from which a transaction was derived.
_Avoid_: Raw input, message

**Import**:
One user-initiated attempt to turn one or more source records into transactions.
_Avoid_: Upload, parse job

**Review Item**:
An imported record that needs a user decision because it is ambiguous, low-confidence, or potentially duplicated.
_Avoid_: Error, pending entry

## Classification and guidance

**Category**:
A stable label used to group transactions for reporting and budgets.
_Avoid_: Tag, bucket

**Counterparty**:
The person or business on the other side of a transaction.
_Avoid_: Merchant when the party may be a person, payee when the transaction may be a credit

**Categorization Rule**:
A user-specific instruction that maps a recognized counterparty to a category for future transactions.
_Avoid_: Payee memory, merchant memory

**Budget**:
A user-defined spending limit for a category over a calendar month.
_Avoid_: Goal, cap

**Alert**:
A user-authorized notification produced when a budget or another explicit rule reaches a defined condition.
_Avoid_: Message, reminder

**Projection**:
An estimate based only on the financial records available to Xpensego, presented with its assumptions and limitations.
_Avoid_: Advice, affordability verdict, prediction
