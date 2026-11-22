import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { SidebarSettings } from './SidebarSettings';

export const metadata = { title: 'Sidebar visibility' };

export default async function AdminPage() {
    const session = await auth();
    if (!session?.user) redirect('/login?redirectTo=%2Fadmin');
    if (session.user.email !== 'tarun.singh6893@gmail.com') notFound();
    return <SidebarSettings />;
}
