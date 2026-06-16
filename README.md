# HEIST Tokyo

HEIST Tokyo is a React/Vite frontend powered by an authoritative Python/FastAPI backend. The application uses Supabase for authentication, durable user state, chat history, profile data, scheduling metadata, and memory persistence. The backend coordinates AI model calls, LangGraph-oriented agent workflows, Supermemory retrieval, plan/usage enforcement, and background memory extraction.

## Architecture Summary

```text
React/Vite frontend
  -> Python/FastAPI API
    -> Supabase state and memory tables
    -> LangGraph-style agent orchestration
    -> Gemini/Groq language model providers
    -> Supermemory retrieval and memory enrichment
    -> APScheduler-based proactive alert worker path
```

## Production Backend Decision

The Python/FastAPI stack is the production backend. The previous Node/Express backend has been removed from the active code path and should not be reintroduced for API, Supabase, or AI orchestration logic.

## Frontend

The frontend lives under `src/` and is built with React, Vite, Tailwind CSS, Supabase client auth, and the Motion animation stack. Phase 1 establishes the directory boundaries needed for future extraction of chat, settings, auth, providers, hooks, services, and reusable UI primitives.

## Backend

The current production backend implementation remains in `backend_python.py` during Phase 1. The `backend/app/` package skeleton has been created as the target extraction boundary for Phase 2. Future backend work should move routes, schemas, repositories, services, prompt builders, memory workers, billing logic, and scheduler workers into that package without changing the production contract prematurely.

## Repository Layout

```text
backend_python.py          # Current authoritative FastAPI backend entrypoint
backend/                   # Phase 2 extraction target skeleton
archive/                   # Archived prototype/helper files
src/                       # React/Vite frontend
requirements.txt           # Python backend dependency list
package.json               # Frontend/Vite dependency list and scripts
```

## Local Development

Install frontend dependencies:

```bash
npm install
```

Run the Vite frontend:

```bash
npm run dev
```

Run the FastAPI backend with the appropriate environment variables configured:

```bash
uvicorn backend_python:app --reload
```

## Required Infrastructure

- Supabase project for authentication, profiles, chat history, sessions, memory, and scheduled alerts.
- Python/FastAPI runtime for API and agent orchestration.
- AI provider credentials for the configured Gemini/Groq paths.
- Supermemory credentials when vector memory retrieval is enabled.

## Refactor Status

Phase 1 establishes production ownership and directory boundaries only. It intentionally does not rewrite `backend_python.py` or decompose `src/components/Onboarding.tsx`; those extractions belong to later phases.
