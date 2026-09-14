import type { ReactNode } from 'react';

export const metadata = { title: 'Inpector, Next.js load-order check' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 16 }}>{children}</body>
    </html>
  );
}
