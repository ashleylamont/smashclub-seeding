import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import { authClient } from '../../lib/auth';

export function AdminAccountsPage() {
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const trimmedSearch = search.trim();
  const admins = useQuery({
    queryKey: ['admin', 'admins'],
    queryFn: () => trpc.admin.admins.query(),
  });
  const verifiedAdminCount = admins.data?.filter((account) => account.emailVerified).length ?? 0;
  const accounts = useQuery({
    queryKey: ['admin', 'findAccounts', trimmedSearch],
    queryFn: () => trpc.admin.findAccounts.query({ search: trimmedSearch }),
    enabled: trimmedSearch.length >= 2,
  });
  const changeRole = useMutation({
    mutationFn: (input: { userId: string; admin: boolean }) =>
      trpc.admin.setAdminRole.mutate(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'admins'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'findAccounts'] });
      void queryClient.invalidateQueries({ queryKey: ['me', 'whoami'] });
    },
  });

  const remove = (id: string, name: string) => {
    if (
      window.confirm(
        `Remove admin access for ${name}? Their open sessions will lose admin access immediately.`,
      )
    ) {
      changeRole.mutate({ userId: id, admin: false });
    }
  };

  return (
    <div className="admin-accounts-page">
      <div className="page-header">
        <h2>Admin accounts</h2>
      </div>
      <p className="muted">
        Promote an existing account after its owner has signed in and verified their email. Role
        changes apply to open sessions on their next request.
      </p>
      {changeRole.isError && (
        <p className="error-text" role="alert">
          {changeRole.error.message}
        </p>
      )}
      {changeRole.isSuccess && (
        <p className="banner banner-success" role="status">
          Admin access updated.
        </p>
      )}

      <section className="section">
        <h3>Current admins</h3>
        {admins.isPending && <p className="loading-text">Loading admins…</p>}
        {admins.isError && (
          <p className="error-text" role="alert">
            {admins.error.message}
          </p>
        )}
        <ul className="admin-account-list">
          {admins.data?.map((account) => (
            <li key={account.id} className="admin-account-row">
              <span>
                <strong>{account.name}</strong> <span className="muted">{account.email}</span>
                {account.id === session?.user.id && <span className="chip">You</span>}
                {!account.emailVerified && (
                  <span className="chip">Email unverified · access suspended</span>
                )}
              </span>
              <button
                type="button"
                className="btn btn-small"
                disabled={
                  changeRole.isPending || (account.emailVerified && verifiedAdminCount <= 1)
                }
                onClick={() => remove(account.id, account.name)}
              >
                Remove admin
              </button>
            </li>
          ))}
        </ul>
        {verifiedAdminCount === 1 && (
          <p className="muted">Promote another account before removing the last active admin.</p>
        )}
      </section>

      <section className="section">
        <h3>Promote an account</h3>
        <label htmlFor="admin-account-search">Search signed-in accounts by name or email</label>
        <input
          id="admin-account-search"
          className="input admin-account-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Name or email"
        />
        {trimmedSearch.length > 0 && trimmedSearch.length < 2 && (
          <p className="muted">Enter at least two characters.</p>
        )}
        {accounts.isFetching && <p className="loading-text">Searching accounts…</p>}
        {accounts.isError && (
          <p className="error-text" role="alert">
            {accounts.error.message}
          </p>
        )}
        {accounts.data?.length === 0 && (
          <p className="muted">No accounts found. Ask the person to sign in first.</p>
        )}
        <ul className="admin-account-list">
          {accounts.data?.map((account) => (
            <li key={account.id} className="admin-account-row">
              <span>
                <strong>{account.name}</strong> <span className="muted">{account.email}</span>
                {!account.emailVerified && <span className="chip">Email unverified</span>}
              </span>
              {account.role === 'admin' ? (
                <span className="chip chip-accent">Admin</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={!account.emailVerified || changeRole.isPending}
                  onClick={() => changeRole.mutate({ userId: account.id, admin: true })}
                >
                  Promote
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
