<?php
/**
 * PlugNest Media Folders — 移除外掛時的清理。
 *
 * ⚠️ 這裡做的事：
 *   1. 刪除外掛的設定（規則、旗標）
 *   2. 刪除操作記錄資料表
 *   3. 刪除使用狀態快取（postmeta）
 *   4. 刪除外掛建立的兩個分類法底下的所有項目
 *
 * ⚠️ 這裡「絕對不會」做的事：
 *   刪除、移動、改名任何媒體檔案，也不會改動任何媒體的路徑或網址。
 *   移除外掛後，媒體庫會回到「沒有分類」的狀態，但所有檔案完好無損。
 *
 * 若只想停用而不想失去分類，請直接「停用」外掛，不要刪除。
 *
 * @package PlugNest Media Folders
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

/* ---------- 1. 設定 ---------- */
$options = array(
	'pnmf_version',
	'pnmf_auto_rules',
	'pnmf_notice_dismissed',
	'pnmf_migrated_from_tkm',
	'pnmf_migrated_mn',
	/* 舊前綴時期的鍵名（2.5.1 之前；遷移未跑完即解除安裝的保險清理）。 */
	'mn_mm_version',
	'mn_mm_auto_rules',
	'mn_mm_notice_dismissed',
	'mn_mm_migrated_from_tkm',
	'mn_mm_default_folders_created',
	'mn_mm_default_tags_created',
	/* 核心為舊 taxonomy 自建的 {tax}_children 階層快取。 */
	'mn_media_folder_children',
	'mn_media_tag_children',
	'tkm_media_folder_children',
	'tkm_media_tag_children',
);

foreach ( $options as $option ) {
	delete_option( $option );
}

/* ---------- 2. 操作記錄資料表 ---------- */
foreach ( array( 'pnmf_media_log', 'mn_media_log' ) as $log_table ) {
	$table = $wpdb->prefix . $log_table;
	$wpdb->query( "DROP TABLE IF EXISTS {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
}

/* ---------- 3. 使用狀態快取 ---------- */
foreach ( array( '_pnmf_usage', '_pnmf_usage_at', '_pnmf_filesize', '_mn_mm_usage', '_mn_mm_usage_at', '_mn_mm_filesize' ) as $meta_key ) {
	$wpdb->delete( $wpdb->postmeta, array( 'meta_key' => $meta_key ), array( '%s' ) );
}

/* ---------- 4. 引用索引快取（含舊鍵名） ---------- */
delete_transient( 'pnmf_usage_index' );
delete_transient( 'mn_mm_usage_index' );
$wpdb->query(
	"DELETE FROM {$wpdb->options}
	 WHERE option_name LIKE '\\_transient\\_pnmf\\_job\\_%'
	    OR option_name LIKE '\\_transient\\_timeout\\_pnmf\\_job\\_%'
	    OR option_name LIKE '\\_transient\\_mn\\_mm\\_job\\_%'
	    OR option_name LIKE '\\_transient\\_timeout\\_mn\\_mm\\_job\\_%'"
);

/* ---------- 5. 分類項目 ---------- */
/*
 * 刪除這兩個分類法底下的所有項目。
 * 這是「分類」而非「內容」，刪掉不會影響任何媒體檔案；
 * 但如果你之後可能重新安裝並想保留分類，請改為直接停用外掛。
 */
foreach ( array( 'pnmf_media_folder', 'pnmf_media_tag', 'mn_media_folder', 'mn_media_tag' ) as $taxonomy ) {
	$term_ids = $wpdb->get_col(
		$wpdb->prepare(
			"SELECT term_id FROM {$wpdb->term_taxonomy} WHERE taxonomy = %s",
			$taxonomy
		)
	);

	if ( ! $term_ids ) {
		continue;
	}

	foreach ( $term_ids as $term_id ) {
		wp_delete_term( (int) $term_id, $taxonomy );
	}
}

flush_rewrite_rules();
