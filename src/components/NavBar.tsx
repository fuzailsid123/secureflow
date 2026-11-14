'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Workflows' },
  { href: '/audit', label: 'Log audit' },
  { href: '/benchmark', label: 'Benchmark' },
];

export default function NavBar() {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/workflows') : path.startsWith(href));
  return (
    <nav className="nav">
      <Link href="/" className="brand">
        <span className="dot" /> SecureFlow
      </Link>
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={`link${active(l.href) ? ' active' : ''}`}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
