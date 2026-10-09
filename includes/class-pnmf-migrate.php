<?php
/**
 * PlugNest Media Folders — 前綴改名資料遷移（mn_* → pnmf_*，一次性、冪等）。
 *
 * 2.5.1 起所有識別字（taxonomy slug、資料表、option／meta／transient 鍵）
 * 從「mn」前綴改為「pnmf」（wp.org 要求前綴至少四字元）。本類把既有站的
 * 資料原地改名：分類關係、角色／顏色／星標、操作記錄、自動分類規則
 * 全部原封不動，只換鍵名。
 *
 * 觸發時機：admin_init（檔案直接覆蓋、未重新啟用也會跑）＋啟用鉤。
 *
 * ⚠ 本檔內的「mn_mm_*」「mn_media_*」字串是刻意保留的【舊鍵名】，
 *   供資料庫查找用，不要批量替換掉。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

class PNMF_Migrate {

	/**
	 * 遷移入口（一次性；完成後寫入 pnmf_migrated_mn 旗標）。
	 *
	 * @return void
	 */
	public static function maybe_migrate() {
		if ( get_option( 'pnmf_migrated_mn' ) ) {
			return;
		}

		global $wpdb;

		/* ---------- 1. 分類法改名（term_relationships 不動，只改 term_taxonomy.taxonomy） ---------- */
		foreach (
			array(
				'mn_media_folder' => 'pnmf_media_folder',
				'mn_media_tag'    => 'pnmf_media_tag',
			) as $old_tax => $new_tax
		) {
			$exists = $wpdb->get_var(
				$wpdb->prepare( "SELECT taxonomy FROM {$wpdb->term_taxonomy} WHERE taxonomy = %s LIMIT 1", $old_tax )
			);
			if ( $exists ) {
				$wpdb->update(
					$wpdb->term_taxonomy,
					array( 'taxonomy' => $new_tax ),
					array( 'taxonomy' => $old_tax )
				);
				clean_taxonomy_cache( $new_tax );
			}
		}

		/* ---------- 2. 操作記錄資料表 RENAME ---------- */
		$old_table = $wpdb->prefix . 'mn_media_log';
		$new_table = $wpdb->prefix . PNMF_TBL_LOG;
		if (
			$wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $old_table ) ) === $old_table
			&& $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $new_table ) ) !== $new_table
		) {
			// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery
			$wpdb->query( "RENAME TABLE `{$old_table}` TO `{$new_table}`" );
		}

		/* ---------- 3. postmeta 鍵（使用狀態快取＋尺寸索引） ---------- */
		foreach (
			array(
				'_mn_mm_usage'    => '_pnmf_usage',
				'_mn_mm_usage_at' => '_pnmf_usage_at',
				'_mn_mm_filesize' => '_pnmf_filesize',
			) as $old_key => $new_key
		) {
			$wpdb->update(
				$wpdb->postmeta,
				array( 'meta_key' => $new_key ),
				array( 'meta_key' => $old_key )
			);
		}

		/* ---------- 4. termmeta 鍵（資料夾角色／顏色／星標） ---------- */
		foreach (
			array(
				'mn_mm_roles' => 'pnmf_roles',
				'mn_mm_color' => 'pnmf_color',
				'mn_mm_star'  => 'pnmf_star',
			) as $old_key => $new_key
		) {
			$wpdb->update(
				$wpdb->termmeta,
				array( 'meta_key' => $new_key ),
				array( 'meta_key' => $old_key )
			);
		}

		/* ---------- 5. option 鍵搬移（舊鍵存在才搬） ---------- */
		foreach (
			array(
				'mn_mm_version'           => 'pnmf_version',
				'mn_mm_auto_rules'        => 'pnmf_auto_rules',
				'mn_mm_notice_dismissed'  => 'pnmf_notice_dismissed',
				'mn_mm_migrated_from_tkm' => 'pnmf_migrated_from_tkm',
				/* Pro 授權 option（Pro 未啟用的站也要清得到；與 Pro 端遷移冪等互補）。 */
				'mn_mm_pro_license'       => 'pnmf_pro_license',
			) as $old_opt => $new_opt
		) {
			$old_value = get_option( $old_opt );
			$new_value = get_option( $new_opt );
			/* 新鍵「不存在或為空字串」時才搬：空字串不該擋住舊值而被白刪。 */
			if ( false !== $old_value && ( false === $new_value || '' === $new_value ) ) {
				update_option( $new_opt, $old_value );
			}
			if ( false !== $old_value ) {
				delete_option( $old_opt );
			}
		}

		/* ---------- 6. 死鍵清理（2.2.0「零預設分類」後已無人讀寫的舊旗標，
		 *   以及核心為舊 taxonomy 自建的 {tax}_children 階層快取——
		 *   新 taxonomy 的快取由核心自動重建） ---------- */
		delete_option( 'mn_mm_default_folders_created' );
		delete_option( 'mn_mm_default_tags_created' );
		delete_option( 'mn_media_folder_children' );
		delete_option( 'mn_media_tag_children' );
		delete_option( 'tkm_media_folder_children' );
		delete_option( 'tkm_media_tag_children' );

		/* ---------- 7. transient 清理（快取性質，直接棄置重建即可） ---------- */
		delete_transient( 'mn_mm_usage_index' );
		$wpdb->query(
			"DELETE FROM {$wpdb->options}
			 WHERE option_name LIKE '\\_transient\\_mn\\_mm\\_job\\_%'
			    OR option_name LIKE '\\_transient\\_timeout\\_mn\\_mm\\_job\\_%'"
		);

		update_option( 'pnmf_migrated_mn', 1, false );
	}
}
