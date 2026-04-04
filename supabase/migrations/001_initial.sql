-- Checkbook app initial schema

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'checking'
    check (type in ('checking', 'savings', 'credit_card', 'cash', 'other')),
  initial_balance numeric(12,2) not null default 0,
  sort_order integer not null default 0,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_id uuid references categories(id) on delete set null,
  type text not null default 'expense'
    check (type in ('income', 'expense')),
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  txn_date date not null default current_date,
  payee text not null default '',
  amount numeric(12,2) not null default 0,
  check_number text,
  memo text,
  status text not null default 'pending'
    check (status in ('pending', 'cleared', 'reconciled')),
  transfer_link_id uuid,
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists transaction_splits (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  amount numeric(12,2) not null default 0,
  memo text
);

create table if not exists recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  frequency text not null
    check (frequency in (
      'weekly', 'biweekly', 'monthly', 'semimonthly',
      'quarterly', 'biannually', 'yearly'
    )),
  next_date date not null,
  end_date date,
  template jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_accounts_user on accounts(user_id);
create index if not exists idx_transactions_account on transactions(account_id);
create index if not exists idx_transactions_date on transactions(txn_date);
create index if not exists idx_transaction_splits_txn on transaction_splits(transaction_id);
create index if not exists idx_categories_user on categories(user_id);
create index if not exists idx_recurring_rules_account on recurring_rules(account_id);

-- Row Level Security
alter table accounts enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;
alter table transaction_splits enable row level security;
alter table recurring_rules enable row level security;

create policy "Users manage own accounts"
  on accounts for all using (auth.uid() = user_id);

create policy "Users manage own categories"
  on categories for all using (auth.uid() = user_id);

create policy "Users manage own transactions"
  on transactions for all using (auth.uid() = user_id);

create policy "Users manage own splits"
  on transaction_splits for all
  using (
    exists (
      select 1 from transactions t
      where t.id = transaction_splits.transaction_id
        and t.user_id = auth.uid()
    )
  );

create policy "Users manage own recurring rules"
  on recurring_rules for all using (auth.uid() = user_id);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger accounts_updated_at
  before update on accounts
  for each row execute function update_updated_at();

create trigger transactions_updated_at
  before update on transactions
  for each row execute function update_updated_at();

create trigger recurring_rules_updated_at
  before update on recurring_rules
  for each row execute function update_updated_at();

-- Enable realtime
alter publication supabase_realtime add table accounts;
alter publication supabase_realtime add table transactions;
alter publication supabase_realtime add table transaction_splits;
alter publication supabase_realtime add table categories;
alter publication supabase_realtime add table recurring_rules;
