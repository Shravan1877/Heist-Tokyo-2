// Centralized backend API utility for the authoritative FastAPI service.
const meta = import.meta as any;

export const DEFAULT_API_BASE_URL = "http://localhost:8000";
export const API_BASE_URL = (meta.env?.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, "");

/**
 * Returns a fully-qualified URL pointing to the Python/FastAPI backend.
 * Override with VITE_API_BASE_URL when the API is hosted somewhere other than localhost:8000.
 */
export function getApiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
}
