package services

import (
	"database/sql"
	"errors"
	"fmt"
)

// cloud_vaults binds a local space to the server-assigned cloud vault it syncs
// to, scoped to the cloud account that owns the binding. It carries NO secret
// material: the vault key lives only in CloudService memory (unwrapped from the
// account keyset each session). The cursor column is an optional incremental-
// pull optimization; v1 sync pages a full snapshot each cycle and leaves it 0.
//
//	space_id   local Space id (PK — one cloud vault per space)
//	vault_id   server vault UUID
//	account_id cloud account id that created the binding (v7 — account isolation)
//	cursor     last pulled seq (0 = full snapshot each cycle)
//	created_at unix ms when the binding was made

// CloudVaultRow is one space↔vault binding.
type CloudVaultRow struct {
	SpaceID   string
	VaultID   string
	AccountID string
	Cursor    int64
	CreatedAt int64
}

// ensureCloudVaultsSchema creates the cloud_vaults table idempotently (v6 + v7
// columns for fresh installs).
func (db *VaultDB) ensureCloudVaultsSchema() error {
	_, err := db.handle.Exec(`
		CREATE TABLE IF NOT EXISTS cloud_vaults (
			space_id   TEXT    PRIMARY KEY,
			vault_id   TEXT    NOT NULL,
			account_id TEXT    NOT NULL DEFAULT '',
			cursor     INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_vaults_vault
			ON cloud_vaults (vault_id);
	`)
	if err != nil {
		return fmt.Errorf("create cloud_vaults: %w", err)
	}
	return nil
}

// ensureCloudVaultsAccountColumn adds the v7 account_id column to a cloud_vaults
// table created under v6 (idempotent: skipped if the column already exists).
func (db *VaultDB) ensureCloudVaultsAccountColumn() error {
	has, err := db.hasColumn("cloud_vaults", "account_id")
	if err != nil {
		return err
	}
	if has {
		return nil
	}
	_, err = db.handle.Exec(`ALTER TABLE cloud_vaults ADD COLUMN account_id TEXT NOT NULL DEFAULT ''`)
	if err != nil {
		return fmt.Errorf("add cloud_vaults.account_id: %w", err)
	}
	return nil
}

// hasColumn reports whether table has a column of the given name (PRAGMA
// table_info), used by the idempotent column-add migrations.
func (db *VaultDB) hasColumn(table, column string) (bool, error) {
	rows, err := db.handle.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, fmt.Errorf("pragma table_info(%s): %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, fmt.Errorf("scan table_info: %w", err)
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

const cloudVaultCols = "space_id, vault_id, account_id, cursor, created_at"

func scanCloudVault(s interface{ Scan(...any) error }) (CloudVaultRow, error) {
	var r CloudVaultRow
	err := s.Scan(&r.SpaceID, &r.VaultID, &r.AccountID, &r.Cursor, &r.CreatedAt)
	return r, err
}

// GetCloudVaultBySpace returns the binding for a space, or (nil, nil) if the
// space is not cloud-synced.
func (db *VaultDB) GetCloudVaultBySpace(spaceID string) (*CloudVaultRow, error) {
	row := db.handle.QueryRow(
		`SELECT `+cloudVaultCols+` FROM cloud_vaults WHERE space_id = ?`, spaceID)
	r, err := scanCloudVault(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("get cloud vault: %w", err)
	}
	return &r, nil
}

// ListCloudVaults returns every space↔vault binding (UI listing).
func (db *VaultDB) ListCloudVaults() ([]CloudVaultRow, error) {
	return db.queryCloudVaults(`SELECT ` + cloudVaultCols + ` FROM cloud_vaults ORDER BY created_at ASC`)
}

// ListCloudVaultsForAccount returns the bindings the sync engine should iterate
// for accountID: those owned by it, plus legacy bindings with no account
// recorded (account_id ”), which are adopted on first successful sync and
// dropped if the account turns out not to be a member. Bindings owned by a
// DIFFERENT account are excluded so they never 404 on member/self.
func (db *VaultDB) ListCloudVaultsForAccount(accountID string) ([]CloudVaultRow, error) {
	return db.queryCloudVaults(
		`SELECT `+cloudVaultCols+` FROM cloud_vaults
		  WHERE account_id = ? OR account_id = ''
		  ORDER BY created_at ASC`,
		accountID)
}

func (db *VaultDB) queryCloudVaults(q string, args ...any) ([]CloudVaultRow, error) {
	rows, err := db.handle.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("list cloud vaults: %w", err)
	}
	defer rows.Close()
	var out []CloudVaultRow
	for rows.Next() {
		r, err := scanCloudVault(rows)
		if err != nil {
			return nil, fmt.Errorf("scan cloud vault: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PutCloudVault inserts or replaces a space↔vault binding (created_at preserved
// on conflict); account_id records the owning cloud account.
func (db *VaultDB) PutCloudVault(spaceID, vaultID, accountID string, createdAt int64) error {
	_, err := db.handle.Exec(
		`INSERT INTO cloud_vaults (space_id, vault_id, account_id, cursor, created_at)
		 VALUES (?, ?, ?, 0, ?)
		 ON CONFLICT(space_id) DO UPDATE SET vault_id = excluded.vault_id, account_id = excluded.account_id`,
		spaceID, vaultID, accountID, createdAt,
	)
	if err != nil {
		return fmt.Errorf("put cloud vault: %w", err)
	}
	return nil
}

// SetCloudVaultAccount adopts a legacy binding under accountID once the account
// has proven membership (a successful vault-key unwrap).
func (db *VaultDB) SetCloudVaultAccount(spaceID, accountID string) error {
	_, err := db.handle.Exec(`UPDATE cloud_vaults SET account_id = ? WHERE space_id = ?`, accountID, spaceID)
	if err != nil {
		return fmt.Errorf("set cloud account: %w", err)
	}
	return nil
}

// SetCloudVaultCursor updates the incremental-pull cursor for a binding.
func (db *VaultDB) SetCloudVaultCursor(spaceID string, cursor int64) error {
	_, err := db.handle.Exec(`UPDATE cloud_vaults SET cursor = ? WHERE space_id = ?`, cursor, spaceID)
	if err != nil {
		return fmt.Errorf("set cloud cursor: %w", err)
	}
	return nil
}

// DeleteCloudVault removes a space↔vault binding (local data untouched).
func (db *VaultDB) DeleteCloudVault(spaceID string) error {
	_, err := db.handle.Exec(`DELETE FROM cloud_vaults WHERE space_id = ?`, spaceID)
	if err != nil {
		return fmt.Errorf("delete cloud vault: %w", err)
	}
	return nil
}

// SpaceItemRowsForSync returns all rows (including tombstones) belonging to a
// space, for building a cloud sync manifest. It queries by space_id directly
// (indexed) rather than scanning every item across all spaces.
func (db *VaultDB) SpaceItemRowsForSync(spaceID string) ([]VaultItemRow, error) {
	rows, err := db.handle.Query(
		`SELECT id, payload, created_at, updated_at, deleted_at, space_id
		   FROM vault_items
		  WHERE space_id = ?
		  ORDER BY updated_at DESC`,
		spaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("query space items: %w", err)
	}
	defer rows.Close()
	var out []VaultItemRow
	for rows.Next() {
		var r VaultItemRow
		var deletedAt sql.NullInt64
		if err := rows.Scan(&r.ID, &r.Payload, &r.CreatedAt, &r.UpdatedAt, &deletedAt, &r.SpaceID); err != nil {
			return nil, fmt.Errorf("scan space item: %w", err)
		}
		if deletedAt.Valid {
			v := deletedAt.Int64
			r.DeletedAt = &v
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
