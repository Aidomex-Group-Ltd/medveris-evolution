# Audit amendments and ledger integrity

## Meaning of immutability

Medveris preserves the history of signed clinical records through append-only versions and independently verifiable evidence. This offers tamper evidence within a declared trust model; it cannot prove that an original clinical statement was true, prevent every administrator attack, or repair a wrong-patient entry automatically. Do not market a database hash alone as blockchain protection.

Clinical content, identity documents and radiology images remain in protected storage. Do not place patient IDs, names, record URLs, diagnosis codes or raw predictable-content hashes on a public ledger. Even hashes can create linkage and guessing risks. Anchor only reviewed batch commitments with randomized leaves and an explicit privacy assessment.

## Event and correction policy

Every create, draft edit, sign, amendment, status correction and entered-in-error action records a meaningful audit note. Also audit protected reads, lookup, denied access, disclosures, exports, consent, membership changes, credential decisions and emergency overrides. Automatically generated descriptions can cover routine draft saves; signed-record corrections require an explicit author-provided reason.

Clinical entry versions preserve original bytes or deterministic canonical representations, schema version, source, author, occurrence time, recorded time, signature and previous-version reference. Derived summaries may be refreshed, but retain their source-version references. An amendment records changed fields and a concise reason. Restrict sensitive details in access audit metadata; the audit system is itself protected data.

## Integrity pipeline

1. A clinical transaction inserts the version, its audit event and outbox event atomically.
2. The integrity worker reads immutable event IDs in deterministic partition order. Use tenant/time partitions and batch sequence numbers rather than one globally contended chain.
3. Compute leaf commitments using a documented canonical encoding, algorithm version, record digest and cryptographically random nonce. Preserve proof material in private access-controlled storage.
4. Build a Merkle tree and sign a checkpoint containing partition, batch number, prior checkpoint hash, event count, root, covered event range, algorithm version and signing-key ID.
5. Store checkpoints and proofs in a separately protected verification archive. Track missing batches and signed key rotation history.
6. If enabled and approved, submit only the batch commitment to the selected ledger adapter and record transaction reference, network, confirmation/finality state and verification time.
7. Verify original content against its leaf, Merkle proof, signed checkpoint and optional ledger anchor. Detect modified bytes, missing/reordered batches, invalid keys and mismatched roots.

Randomization mitigates simple public guessing but does not eliminate all metadata leakage. Final ledger selection must consider visibility, custody, finality, costs, outages, correction/retention policy and public correlation risk. A permissioned network still needs independent governance to offer more than a single operator's assertion.

## Ledger adapter states

`not-requested`, `pending`, `submitted`, `confirmed`, `failed`, `verification-failed`. Interface methods: `submitCommitment`, `getConfirmation`, `verifyAnchor`; request contains a batch commitment and no patient payload. Proposed networks, fees and confirmation counts are intentionally undecided. Development adapter must be visibly labelled simulation. M1 uses signed checkpoints with state `not-requested`, not false blockchain confirmations.

Clinical writes continue during a ledger outage if the primary audit transaction succeeds. Retry anchors idempotently and alert on backlog. A failure to persist the primary audit transaction blocks the clinical commit. Key compromise triggers rotation, incident investigation and verification of affected intervals; it must not silently rewrite checkpoints.

## Retention and disposal

Append-only runtime operation is not a promise of perpetual retention. Define jurisdiction-approved schedules, legal holds and a restricted disposal process for records, audit content, proof material, derivatives and backups. Preserve a minimal authorized disposal manifest. Encryption-key destruction may support disposal but does not by itself prove every external copy is erased. Assess ledger commitments under the adopted privacy policy before production anchoring.

## Standards provenance and audit linkage

Map clinical authorship/version lineage to FHIR Provenance and security disclosures to AuditEvent without treating them as interchangeable. Audit FHIR searches/history, DICOMweb reads/stores and protected integration deliveries. Preserve exact source/version and terminology release used in signed content digests. Terminology upgrades do not regenerate historical signed content or its integrity proofs. A FHIR transport version and the original clinical signing version can differ; keep their mapping explicit.
