package services

// 条目附件（vault_attachments）的服务层 —— DEK 加密的文件名与内容，落本地库，
// 云同步由 cloudsync.go 的 reconcileAttachments 负责（与条目同样的「本地写入、
// 同步推送」解耦模型；VaultService 不直接依赖 CloudService）。
//
// 加密：文件名与内容分别 SealAEAD(dek, ..., aad)，aad 用 attachmentNameAAD /
// attachmentBlobAAD（前缀 + attachment.id），使密文不可在名↔内容、附件↔附件
// 之间互换。size_bytes 明文（仅长度，非敏感）。
//
// 空间隔离：所有方法都校验目标条目存在且属于当前激活空间（复用与 ListItemHistory
// 相同的门禁），防止越权读写别的空间条目的附件。

import (
	"encoding/base64"
	"errors"
	"fmt"
)

// AttachmentSummary 是 ListAttachments 返回的附件摘要（不含内容 blob）
//
//   - ID        : vault_attachments.id（删除 / 下载时回传）
//   - FileName  : 解密后的文件名（已解锁会话内可见）
//   - SizeBytes : 明文内容字节数
//   - CreatedAt : 创建时刻 unix ms
//   - Synced    : 是否已同步到云端（cloud_id 非空）
type AttachmentSummary struct {
	ID        string `json:"id"`
	FileName  string `json:"fileName"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt int64  `json:"createdAt"`
	Synced    bool   `json:"synced"`
}

// AttachmentData 是 GetAttachmentData 的返回 —— 文件名 + base64 内容（供前端另存为）
type AttachmentData struct {
	FileName string `json:"fileName"`
	// DataB64 是 base64(STANDARD) 编码的明文内容。用 base64 字符串而非 []byte
	// 跨 Wails 边界更稳（[]byte 在部分绑定下序列化行为不一致）。
	DataB64 string `json:"dataB64"`
}

// requireItemInCurrentSpaceLocked 校验条目存在且属于当前激活空间，返回其行。
// 调用方须已持锁（读或写均可，只读 s.currentSpaceID 与 db）。
func (s *VaultService) requireItemInCurrentSpaceLocked(itemID string) (*VaultItemRow, error) {
	if itemID == "" {
		return nil, errors.New("item id cannot be empty")
	}
	row, err := s.db.GetItem(itemID)
	if err != nil {
		return nil, fmt.Errorf("get item: %w", err)
	}
	if row == nil {
		return nil, ErrItemNotFound
	}
	if s.currentSpaceID == "" || row.SpaceID != s.currentSpaceID {
		return nil, ErrItemNotFound
	}
	return row, nil
}

// AddAttachment 为条目新增一个附件
//
// dataB64 是 base64(STANDARD) 编码的明文内容（前端读文件后编码上传）。流程：
//  1. 校验条目存在且属当前空间
//  2. 校验大小 ≤ 5MiB（与云端 DB 模式硬上限一致），超限明确报错
//  3. 文件名与内容分别 SealAEAD（aad 见 attachmentNameAAD / attachmentBlobAAD）
//  4. 落本地库（cloud_id 留空 —— 由 reconcileAttachments 推送上云）
//  5. notifyVaultChanged 触发一次云同步（推送本附件）
//
// 同步说明：与条目一致采用「本地写入 + 同步推送」解耦模型，AddAttachment 不做
// 内联上传（VaultService 无 CloudService 引用）。配额超限（HTTP 403）由
// reconcileAttachments 处理：上传被拒时回滚（硬删）本地附件行并发警告事件，
// 因为继续留在本地只会每轮重试且永远同步不上去，造成两端不一致。
func (s *VaultService) AddAttachment(itemID, fileName, dataB64 string) (*AttachmentSummary, error) {
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, fmt.Errorf("decode attachment data: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if fileName == "" {
		return nil, errors.New("attachment file name cannot be empty")
	}
	if len(data) == 0 {
		return nil, errors.New("attachment content cannot be empty")
	}
	if len(data) > attachmentMaxBytes {
		return nil, fmt.Errorf("attachment exceeds %d MiB limit", attachmentMaxBytes/(1024*1024))
	}
	if _, err := s.requireItemInCurrentSpaceLocked(itemID); err != nil {
		return nil, err
	}

	id, err := newItemID()
	if err != nil {
		return nil, fmt.Errorf("gen attachment id: %w", err)
	}
	plainSize := int64(len(data)) // 记明文长度（用户看到的文件大小），在 Wipe 前取
	nameEnc, err := SealAEAD(s.dek, []byte(fileName), attachmentNameAAD(id))
	if err != nil {
		return nil, fmt.Errorf("seal attachment name: %w", err)
	}
	blobEnc, err := SealAEAD(s.dek, data, attachmentBlobAAD(id))
	WipeBytes(data)
	if err != nil {
		return nil, fmt.Errorf("seal attachment blob: %w", err)
	}

	now := s.nowMs()
	row := &AttachmentRow{
		ID:          id,
		ItemID:      itemID,
		FileNameEnc: nameEnc,
		Blob:        blobEnc,
		SizeBytes:   plainSize,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.db.InsertAttachment(row); err != nil {
		return nil, fmt.Errorf("insert attachment: %w", err)
	}

	s.notifyVaultChanged("attachment-add", "", itemID)
	return &AttachmentSummary{
		ID:        id,
		FileName:  fileName,
		SizeBytes: row.SizeBytes,
		CreatedAt: now,
		Synced:    false,
	}, nil
}

// ListAttachments 返回条目的附件摘要（解密文件名，过滤软删除）
//
// 空间门禁同 AddAttachment。单条文件名解密失败时降级（FileName 留空），不让一条
// 坏数据中断整张列表。
func (s *VaultService) ListAttachments(itemID string) ([]AttachmentSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if _, err := s.requireItemInCurrentSpaceLocked(itemID); err != nil {
		return nil, err
	}

	rows, err := s.db.ListAttachmentsByItem(itemID)
	if err != nil {
		return nil, fmt.Errorf("list attachments: %w", err)
	}
	out := make([]AttachmentSummary, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		sum := AttachmentSummary{
			ID:        r.ID,
			SizeBytes: r.SizeBytes,
			CreatedAt: r.CreatedAt,
			Synced:    r.CloudID != "",
		}
		name, derr := OpenAEAD(s.dek, r.FileNameEnc, attachmentNameAAD(r.ID))
		if derr == nil {
			sum.FileName = string(name)
			WipeBytes(name)
		} else {
			fmt.Printf("[vault] attachment name decrypt %s failed: %v\n", r.ID, derr)
		}
		out = append(out, sum)
	}
	return out, nil
}

// GetAttachmentData 返回指定附件的解密文件名 + base64 内容（供前端另存为）
//
// 空间门禁：附件归属的条目必须属当前激活空间。找不到 / 跨空间 / 已软删均返回
// ErrAttachmentNotFound（不泄露存在性）。
func (s *VaultService) GetAttachmentData(id string) (*AttachmentData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, ErrVaultLocked
	}
	if id == "" {
		return nil, errors.New("attachment id cannot be empty")
	}

	row, err := s.db.GetAttachment(id)
	if err != nil {
		return nil, fmt.Errorf("get attachment: %w", err)
	}
	if row == nil || (row.DeletedAt != nil && *row.DeletedAt > 0) {
		return nil, ErrAttachmentNotFound
	}
	// 空间门禁：附件所属条目必须属当前激活空间。
	if _, err := s.requireItemInCurrentSpaceLocked(row.ItemID); err != nil {
		return nil, ErrAttachmentNotFound
	}

	name, err := OpenAEAD(s.dek, row.FileNameEnc, attachmentNameAAD(row.ID))
	if err != nil {
		return nil, fmt.Errorf("decrypt attachment name: %w", err)
	}
	defer WipeBytes(name)
	blob, err := OpenAEAD(s.dek, row.Blob, attachmentBlobAAD(row.ID))
	if err != nil {
		return nil, fmt.Errorf("decrypt attachment blob: %w", err)
	}
	defer WipeBytes(blob)
	return &AttachmentData{
		FileName: string(name),
		DataB64:  base64.StdEncoding.EncodeToString(blob),
	}, nil
}

// DeleteAttachment 删除附件
//
// 空间门禁同上。语义跟随 vault_items 的软删风格：
//   - 已同步（有 cloud_id）→ 软删（写 tombstone），由 reconcileAttachments 删云端后硬删本地
//   - 未同步（cloud_id 为空）→ 直接硬删本地行（云端没有它，无需墓碑）
//
// 找不到 / 跨空间 → ErrAttachmentNotFound；已软删 → 幂等成功。
func (s *VaultService) DeleteAttachment(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dek == nil {
		return ErrVaultLocked
	}
	if id == "" {
		return errors.New("attachment id cannot be empty")
	}

	row, err := s.db.GetAttachment(id)
	if err != nil {
		return fmt.Errorf("get attachment: %w", err)
	}
	if row == nil {
		return ErrAttachmentNotFound
	}
	if _, err := s.requireItemInCurrentSpaceLocked(row.ItemID); err != nil {
		return ErrAttachmentNotFound
	}
	if row.DeletedAt != nil && *row.DeletedAt > 0 {
		return nil // 幂等
	}

	if row.CloudID != "" {
		// 已上云：软删，由同步补偿删云端后清理本地。
		if err := s.db.SoftDeleteAttachment(id, s.nowMs()); err != nil {
			return fmt.Errorf("soft delete attachment: %w", err)
		}
	} else {
		// 未上云：直接硬删（云端无此附件，无需墓碑传播删除）。
		if err := s.db.DeleteAttachmentRow(id); err != nil {
			return fmt.Errorf("delete attachment: %w", err)
		}
	}
	s.notifyVaultChanged("attachment-delete", "", row.ItemID)
	return nil
}

// ---------------------------------------------------------------------------
// 同步桥接（供 cloudsync 调用）
// ---------------------------------------------------------------------------

// openAttachment 解密一条附件行的文件名与内容（DEK，aad = attachment id 上下文）
//
// 供 cloudsync 推送前转码用。取读锁；调用方负责 Wipe 返回的明文。
func (s *VaultService) openAttachment(r *AttachmentRow) (name, blob []byte, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.dek == nil {
		return nil, nil, ErrVaultLocked
	}
	if r == nil {
		return nil, nil, errors.New("nil attachment row")
	}
	name, err = OpenAEAD(s.dek, r.FileNameEnc, attachmentNameAAD(r.ID))
	if err != nil {
		return nil, nil, fmt.Errorf("decrypt attachment name: %w", err)
	}
	blob, err = OpenAEAD(s.dek, r.Blob, attachmentBlobAAD(r.ID))
	if err != nil {
		WipeBytes(name)
		return nil, nil, fmt.Errorf("decrypt attachment blob: %w", err)
	}
	return name, blob, nil
}

// ingestRemoteAttachment 把从云端下载并解密的附件（明文）以本地 DEK 重新加密落库
//
// 供 cloudsync 拉取用。本端用新的本地 id（hex），记 cloudID + synced_at（标记已同步，
// 避免下一轮被当作「未同步」重新上传）。幂等防御：调用方应已确认本端没有同 cloudID
// 的活动附件（AttachmentCloudIDs）。取写锁。
func (s *VaultService) ingestRemoteAttachment(itemID, cloudID string, fileName, data []byte, plainSize int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dek == nil {
		return ErrVaultLocked
	}
	if itemID == "" || cloudID == "" {
		return errors.New("attachment item id / cloud id cannot be empty")
	}
	id, err := newItemID()
	if err != nil {
		return fmt.Errorf("gen attachment id: %w", err)
	}
	nameEnc, err := SealAEAD(s.dek, fileName, attachmentNameAAD(id))
	if err != nil {
		return fmt.Errorf("seal attachment name: %w", err)
	}
	blobEnc, err := SealAEAD(s.dek, data, attachmentBlobAAD(id))
	if err != nil {
		return fmt.Errorf("seal attachment blob: %w", err)
	}
	now := s.nowMs()
	row := &AttachmentRow{
		ID:          id,
		ItemID:      itemID,
		FileNameEnc: nameEnc,
		Blob:        blobEnc,
		SizeBytes:   plainSize,
		CreatedAt:   now,
		UpdatedAt:   now,
		CloudID:     cloudID,
		SyncedAt:    &now,
	}
	if err := s.db.InsertAttachment(row); err != nil {
		return fmt.Errorf("insert remote attachment: %w", err)
	}
	return nil
}
