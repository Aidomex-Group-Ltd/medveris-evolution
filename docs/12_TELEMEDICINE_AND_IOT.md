# Telemedicine and connected observations

## Remote consultation

Schedule → verify patient/provider identity → document consultation consent → join authorized session → record observations and consultation → sign plan → arrange in-person escalation or follow-up. Confirm patient location and a practical contact route for urgent escalation under approved local policy. Make limitations of remote examination visible. A failed call has fallback instructions and does not create a false completed clinical encounter.

Use a selected WebRTC media service with appropriate security, regional processing and contracts. Workers can authorize sessions and issue participant-specific short-lived tokens. Camera, microphone and screen sharing require user controls. Exclude bystanders and unauthorized participants. Recording is off by default; recording/transcription requires separate consent, purpose, retention and access policy. Do not assume end-to-end encryption is compatible with server recording or inference; document the actual media security model.

## Device boundary

Hospital/home device → authenticated local/vendor gateway → scoped ingestion API → validation and patient binding → persisted observation → approved rules/alert routing → staff acknowledgement. MQTT or vendor protocols terminate at an appropriate gateway, not an invented Workers-native broker. Validate each actual device model and adapter, not only the generic JSON contract.

Device registry records manufacturer/model, serial or opaque identity, firmware, supported measures, units, calibration/maintenance status, owner, integration credential, site and revoked state. Device assignment links a patient and encounter over an explicit time interval with an authenticated operator. Confirm patient identity before assigning and when moving equipment.

## Ingestion contract

Each measurement supplies event ID, device ID, binding reference, metric code/system, value, unit, measurement time, gateway receipt time, sequence, quality flags and schema version. Gateway signatures or mutually authenticated transport establish source. API derives permitted tenant from credentials and verifies any declared tenant. Reject unsupported units, invalid device bindings and revoked devices. Preserve raw values with bounded payloads and trace normalized values.

Deduplicate repeated events by adapter/device/event ID. Handle out-of-order readings without presenting old readings as current. Check clock drift, disconnection, missing sequences and low-quality values. Future-dated or ambiguous historical assignments require quarantine/reconciliation. A valid clinical result may be physiologically unusual; quarantine based on documented quality rules rather than silently replacing it with a plausible value.

## Alerts

Rule configuration requires clinical approval, metric/units, eligible population, version, threshold or trend condition, persistence window, severity, destination, coverage hours and escalation owner. No example clinical numeric thresholds are supplied in this kit. Separate physiological alerts from technical alarms such as missing device data.

Alert states: open → delivered → acknowledged → reviewed/resolved; include escalated, duplicate-suppressed and invalidated with audit reasons. Record who acknowledged and when; delivery alone is not acknowledgement. Monitor staff availability, queue lag, notification failures and unacknowledged alerts. Define an explicit service-specific detection/delivery budget and measure it in the pilot before activation.

## Critical care constraints

Cloud telemetry is supplementary until the complete device, network, alarm and response pathway has been validated for its intended use. Preserve local bedside alarms and standard observation rounds. No remote ventilator, infusion or life-support control is in scope. Never label a stale monitor tile as live. Show measured time, received time, quality and disconnection status.

## Pilot acceptance

Test wrong-patient binding, device reassignment, duplicated readings, clock drift, late delivery, network loss, revoked credentials, invalid units, technical alarms, acknowledgement and escalation. Begin with synthetic telemetry, then a governed noncritical observation pilot. Expand to wards or critical-care workflows only after device-specific clinical acceptance and operational coverage are established.

## Device and remote-care standards mapping

Map the selected gateway metric to a reviewed LOINC observation identity and UCUM unit; preserve device-native metric, original units and mapping version. Export authorized readings as FHIR Observation with Device, patient, encounter, effective/issued times, quality context and provenance. Unknown device codes enter reconciliation, not an invented LOINC mapping. Telehealth appointments and encounters can map to Appointment/Encounter profiles while media security remains the video provider's separate responsibility. SNOMED CT can represent reviewed findings and categorical values within the relevant bindings.
