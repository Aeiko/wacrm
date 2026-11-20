'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'use-intl';
import { KeyRound } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function SignupPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SignupPasswordForm />
    </Suspense>
  );
}

function SignupPasswordForm() {
  const t = useTranslations('SignupPasswordPage');
  const invite = useSearchParams().get('invite');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password !== confirmation) {
      setError(t('passwordsMismatch'));

      return;
    }

    if (password.length < 6) {
      setError(t('passwordTooShort'));

      return;
    }

    setError(null);
    setSaving(true);

    try {
      // The gateway authorizes the SDK's PUT using the server-bound signup session.
      const { error } = await createClient().auth.updateUser({ password });

      if (error) {
        setError(error.message);
      } else {
        const destination =
          invite && /^[A-Za-z0-9_-]{43}$/.test(invite)
            ? `/join/${invite}`
            : '/dashboard';

        // Reload so dashboard middleware sees the SDK's session cookies.
        window.location.replace(new URL(destination, window.location.origin));

        return;
      }
    } catch {
      setError(t('saveFailed'));
    }

    setSaving(false);
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center px-4">
      <Card className="border-border bg-card w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <KeyRound aria-hidden="true" className="text-primary h-6 w-6" />
          </div>
          <CardTitle className="text-foreground text-xl">
            {t('title')}
          </CardTitle>
          <CardDescription>{t('desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            method="post"
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
          >
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
              >
                {error}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('passwordLabel')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword">
                {t('confirmPasswordLabel')}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                required
              />
            </div>
            <Button
              type="submit"
              disabled={saving}
              className="mt-2 h-10 w-full"
            >
              {saving ? t('saving') : t('submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
