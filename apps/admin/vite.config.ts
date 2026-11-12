import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_API_URL (default http://localhost:3000) is read in src/lib.tsx
export default defineConfig({ plugins: [react()], server: { port: 5173 } });
