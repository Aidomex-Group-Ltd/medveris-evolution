# Medveris Integration Sandbox

This directory contains the configurations and adapters to run Medveris integrations in `sandbox` mode locally or in staging environments.

## Principles

1. **Honesty**: Sandbox integrations never present themselves as `available` or live. They clearly show `sandbox` state with explicit warnings.
2. **Production Block**: Setting `*_MODE=sandbox` when `APP_ENV=production` causes the system to fail at startup.
3. **Synthetic Data**: All data generated or ingested in sandbox mode is marked with `simulated = true` and `source = "sandbox:<adapter>"`.

## Local Services Setup

Run the external sandbox services:

```bash
docker compose -f docker-compose.sandbox.yml up -d
```

Available endpoints:
- **Orthanc DICOMweb**: `http://localhost:8042/dicom-web`
- **Ollama AI**: `http://localhost:11434`
- **HAPI FHIR**: `http://localhost:8080/fhir`

## Configured Modes

Set the following environment variables in `.env` to enable individual sandbox adapters:

- `AI_MODE=sandbox`
- `OLLAMA_URL=http://localhost:11434`
- `DICOMWEB_MODE=sandbox`
- `DICOMWEB_BASE_URL=http://localhost:8042/dicom-web`
- `YO_MODE=mock`
- `TERMINOLOGY_MODE=sandbox`
- `TERMINOLOGY_PROVIDER_URL=http://localhost:8080/fhir`
- `DEVICES_MODE=sandbox`
