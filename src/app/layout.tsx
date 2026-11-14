import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import NavBar from '@/components/NavBar';
import './globals.css';

export const metadata: Metadata = {
  title: 'SecureFlow: task scheduler with streaming log security audit',
  description: 'Topological-sort task scheduling plus KMP log scanning, full-stack on Next.js.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
