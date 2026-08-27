-- InfluenceOS — ConnectX configurable HTML templates for attachment types
-- Run after 012_connectx_default_sender.sql

alter table public.connectx_settings add column if not exists allocation_template_html text;
alter table public.connectx_settings add column if not exists payments_template_html text;
alter table public.connectx_settings add column if not exists withdraw_template_html text;
alter table public.connectx_settings add column if not exists contribute_template_html text;
alter table public.connectx_settings add column if not exists performance_template_html text;

update public.connectx_settings set
  allocation_template_html = coalesce(allocation_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Allocation Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Start Date:</b> {{Start}}</p><p><b>Deadline:</b> {{Deadline}}</p><p><b>Target:</b> {{Target}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Commission:</b> {{Commission}}</p><p><b>Status:</b> {{Status}}</p></div>'),
  payments_template_html = coalesce(payments_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Payment Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Project:</b> {{Project}}</p><p><b>Amount:</b> {{Amount}}</p><p><b>Status:</b> {{Status}}</p></div>'),
  withdraw_template_html = coalesce(withdraw_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Withdrawal Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Withdrawal Method:</b> {{Method}}</p><p><b>Destination Account:</b> {{Destination}}</p><p><b>Amount Withdrawn:</b> {{Amount}}</p><p><b>Current Status:</b> {{Status}}</p><p><b>Transaction:</b> {{trx}}</p></div>'),
  contribute_template_html = coalesce(contribute_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Contribution Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Date:</b> {{Date}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Status:</b> {{Status}}</p></div>'),
  performance_template_html = coalesce(performance_template_html, '<div style="margin-top:22px;border:1px solid #111;padding:16px;font-family:Arial,sans-serif"><h3 style="margin:0 0 12px">Performance Details</h3><p><b>Agent ID:</b> {{Agent ID}}</p><p><b>Rank:</b> {{Rank}}</p><p><b>Project:</b> {{Project}}</p><p><b>Category:</b> {{Category}}</p><p><b>Assigned:</b> {{Assigned}}</p><p><b>Acquired:</b> {{Acquired}}</p><p><b>Achievement:</b> {{Achievement}}</p></div>'),
  updated_at = now()
where id = 1;
