import type { ReactNode } from 'react';
import { LastInteraction } from './last-interaction';

export const metadata = { title: 'react-inp-blame, Next.js load-order check' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 16 }}>
        {children}
        <LastInteraction />
      </body>
    </html>
  );
}
