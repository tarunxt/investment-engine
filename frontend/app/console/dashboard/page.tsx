'use client';

import { DashboardProvider } from './_context';
import { DashboardHeader } from './_components/DashboardHeader';
import { CreateJobCard } from './_components/CreateJobCard';
import { RecentJobsTable } from './_components/RecentJobsTable';

export default function DashboardPage() {
  return (
    <DashboardProvider>
      <div className="mx-auto flex flex-col gap-6">
        <DashboardHeader />
        <div className="grid gap-6">
          <CreateJobCard />
          <RecentJobsTable />
        </div>
      </div>
    </DashboardProvider>
  );
}
