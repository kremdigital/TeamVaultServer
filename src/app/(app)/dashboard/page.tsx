'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FolderIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/common/EmptyState';
import { ApiError, apiGet, apiPost } from '@/lib/api/client';

interface ProjectListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconEmoji: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  _count: { members: number; files: number };
}

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { projects: list } = await apiGet<{ projects: ProjectListItem[] }>('/api/projects');
      setProjects(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon className="mr-2 size-4" />
          {t('createProject')}
        </Button>
      </header>

      {!loading && projects.length === 0 && (
        <EmptyState
          icon={<FolderIcon className="size-10" />}
          title={t('empty.title')}
          description={t('empty.text')}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon className="mr-2 size-4" />
              {t('createProject')}
            </Button>
          }
        />
      )}

      {projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <Card className="h-full transition hover:shadow-md">
                <CardContent className="flex flex-col gap-2 p-5">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{p.iconEmoji ?? '📒'}</span>
                    <h3 className="text-lg font-semibold">{p.name}</h3>
                  </div>
                  {p.description && (
                    <p className="text-muted-foreground line-clamp-2 text-sm">{p.description}</p>
                  )}
                  <div className="text-muted-foreground mt-2 flex gap-3 text-xs">
                    <span>{t('memberCount', { count: p._count.members })}</span>
                    <span>{t('fileCount', { count: p._count.files })}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) => {
            setCreateOpen(false);
            void load();
            router.push(`/projects/${id}`);
          }}
        />
      )}
    </div>
  );
}

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('project.createDialog');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [iconEmoji, setIconEmoji] = useState('');
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const { project } = await apiPost<{ project: { id: string } }>('/api/projects', {
        name,
        ...(description ? { description } : {}),
        ...(iconEmoji ? { iconEmoji } : {}),
      });
      onCreated(project.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.error.message : 'Ошибка');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="proj-name">{t('name')}</Label>
            <Input
              id="proj-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="proj-desc">{t('description')}</Label>
            <Input
              id="proj-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="proj-emoji">{t('iconEmoji')}</Label>
            <Input
              id="proj-emoji"
              value={iconEmoji}
              onChange={(e) => setIconEmoji(e.target.value)}
              maxLength={8}
              placeholder="📒"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
