<?php
/**
 * PlugNest Media Folders — 重複檔偵測。
 *
 * 「這個媒體庫裡有沒有內容完全相同的檔案？」
 *
 * 做法：為每個附件的**原始檔**計算一次內容雜湊（MD5），存在
 * `_pnmf_hash` postmeta 裡（分批建置，避免單次請求逾時），之後
 * 依雜湊分組、回報成員數 > 1 的群組。雜湊相同 ⇒ 檔案內容完全一致。
 *
 * ⚠️ 本模組只「偵測」與「報告」，永遠不會刪除任何東西。
 *    清理（保留一份、刪除其餘）是 Pro 外掛的功能；即使在 Pro，
 *    「使用中／未掃描」的副本預設也不會被刪。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

class PNMF_Dupe {

	/** 內容雜湊的 postmeta key（值為 hex 字串；讀不到檔案時存空字串）。 */
	const META_HASH = '_pnmf_hash';

	/** 單批計算雜湊的附件數（大檔案雜湊不便宜，一批不宜過多）。 */
	const CHUNK = 80;

	/** 報告最多回傳的重複群組數。 */
	const MAX_GROUPS = 200;

	/**
	 * 還沒建好雜湊索引的附件數。
	 *
	 * @return int
	 */
	public static function missing_count() {
		global $wpdb;

		return (int) $wpdb->get_var(
			"SELECT COUNT(*)
			   FROM {$wpdb->posts} p
			   LEFT JOIN {$wpdb->postmeta} m
			          ON m.post_id = p.ID AND m.meta_key = '" . self::META_HASH . "'
			  WHERE p.post_type = 'attachment'
			    AND p.post_status IN ('inherit','private','publish')
			    AND m.meta_id IS NULL"
		);
	}

	/**
	 * 為下一批缺雜湊的附件計算並寫入雜湊。
	 *
	 * 刻意不使用 offset：查詢條件是「缺 meta」，每批又把 meta 補上，
	 * 結果集自然前進（與 filesize_build 同一模式）。
	 *
	 * @param int $limit
	 * @return array array( 'processed' => int, 'missing' => int, 'done' => bool )
	 */
	public static function build_batch( $limit = self::CHUNK, $budget = 0, $cancel_cb = null, $skip = array(), $progress_cb = null ) {
		global $wpdb;

		$limit = max( 1, min( 200, (int) $limit ) );

		/* 這一輪已經失敗過的 ID：跳過它們，避免卡在佇列最前面讓其他檔案永遠排不到。 */
		$skip = array_values( array_filter( array_map( 'intval', (array) $skip ) ) );
		$skip = array_slice( $skip, 0, 300 );

		$where = "p.post_type = 'attachment'
			    AND p.post_status IN ('inherit','private','publish')
			    AND m.meta_id IS NULL";

		if ( $skip ) {
			$where .= ' AND p.ID NOT IN (' . implode( ',', $skip ) . ')';
		}

		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT p.ID
				   FROM {$wpdb->posts} p
				   LEFT JOIN {$wpdb->postmeta} m
				          ON m.post_id = p.ID AND m.meta_key = %s
				  WHERE {$where}
				  ORDER BY p.ID ASC
				  LIMIT %d",
				self::META_HASH,
				$limit
			)
		);

		$hashed      = 0;
		$done_cnt    = 0;
		$failed      = array();
		$batch_ids      = array_map( 'intval', (array) $ids );
		$batch_total    = count( $batch_ids );
		$batch_done     = 0;
		$missing_before = self::missing_count();
		$cancelled = false;
		$current   = '';
		$started   = microtime( true );

		foreach ( $ids as $id ) {
			/* 時間預算到了就先回前端，下一輪再續（避免單一請求拖到主機逾時）。 */
			if ( $budget > 0 && ( microtime( true ) - $started ) >= $budget ) {
				break;
			}

			/* 中止旗標（每次都由呼叫端直接讀 DB，避免快取）。 */
			if ( is_callable( $cancel_cb ) && call_user_func( $cancel_cb ) ) {
				$cancelled = true;
				break;
			}

			$id   = (int) $id;
			$file = get_attached_file( $id );

			/*
			 * 讀得到檔案才存雜湊；讀不到（已遺失／offload 到雲端且本機
			 * 無副本）存空字串——標記「已處理」避免每次重掃，空字串
			 * 不會參與分組（空值彼此不可視為重複）。
			 */
			$hash = ( $file && is_readable( $file ) && ! is_dir( $file ) )
				? self::hash_file( $file )
				: '';

			update_post_meta( $id, self::META_HASH, $hash );

			/*
			 * 只有「寫入後真的存在」才算處理完成。
			 * 否則失敗的檔案會被反覆計數，畫面上的「已計算」就會超過媒體總數。
			 */
			if ( metadata_exists( 'post', $id, self::META_HASH ) ) {
				$done_cnt++;
			} else {
				$failed[] = $id;
			}

			if ( '' !== $hash ) {
				$hashed++;
			}

			$current = $file ? basename( $file ) : ( '#' . $id );
			$batch_done++;

			/* 逐檔回報（前端輪詢用），讓「已計數」和「正在處理」來自同一份狀態。 */
			if ( is_callable( $progress_cb ) ) {
				call_user_func( $progress_cb, $batch_done, $current, $batch_total );
			}
		}

		$missing = self::missing_count();
		$done    = ! $cancelled && ( 0 === $missing || empty( $ids ) );

		/*
		 * 這一整批跑完，待辦數卻沒有下降 → 這些 ID 寫不進去（DB／快取／外掛干擾），
		 * 交給前端列入黑名單，避免「ID 最小優先」讓它們永遠佔住佇列。
		 */
		$stuck = array();
		if ( ! $cancelled && $done_cnt > 0 && $missing >= $missing_before ) {
			$stuck = $batch_ids;
		}

		/* 卡住時要能指出是哪幾個檔案（只取樣 10 筆）。 */
		$missing_ids = array();
		if ( $missing > 0 ) {
			$missing_ids = array_map(
				'intval',
				(array) $wpdb->get_col(
					$wpdb->prepare(
						"SELECT p.ID
						   FROM {$wpdb->posts} p
						   LEFT JOIN {$wpdb->postmeta} m
						          ON m.post_id = p.ID AND m.meta_key = %s
						  WHERE p.post_type = 'attachment'
						    AND p.post_status IN ('inherit','private','publish')
						    AND m.meta_id IS NULL
						  ORDER BY p.ID ASC
						  LIMIT 10",
						self::META_HASH
					)
				)
			);
		}

		$total = self::total_count();

		return array(
			'processed' => $done_cnt,
			'hashed'    => $hashed,
			'missing'   => $missing,
			'total'     => $total,
			'failed'    => count( $failed ),
			'failed_ids' => array_slice( $failed, 0, 10 ),
			'missing_ids' => $missing_ids,
			'stuck_ids'   => $stuck,
			'done'      => $done,
			'cancelled' => $cancelled,
			'current'   => $current,
			'elapsed'   => round( microtime( true ) - $started, 2 ),
		);
	}

	/**
	 * 附件總數（進度條分母，固定不變）。
	 *
	 * @return int
	 */
	public static function total_count() {
		global $wpdb;

		return (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->posts}
			  WHERE post_type = 'attachment'
			    AND post_status IN ('inherit','private','publish')"
		);
	}

	/**
	 * 計算檔案雜湊（有上限）。
	 *
	 * 直接 md5_file() 讀整個檔案，遇到超大的影片、或掛在網路磁碟上的檔案，
	 * 單一請求會卡住好幾分鐘，中止旗標也無法及時生效（PHP 卡在 I/O 裡）。
	 * 所以：小於門檻的檔案照舊用完整 md5（與舊資料相容），
	 * 超過門檻只讀前段 + 檔案大小，時間有上限，仍足以辨識重複。
	 *
	 * @param string $file 絕對路徑。
	 * @return string
	 */
	private static function hash_file( $file ) {
		$limit = (int) apply_filters( 'pnmf_hash_sample_bytes', 8 * MB_IN_BYTES );
		$size  = @filesize( $file );

		if ( false === $size || $size < 0 ) {
			return '';
		}

		/* 小檔案：完整 md5，與既有資料一致。 */
		if ( $size <= $limit ) {
			$hash = @md5_file( $file );
			return $hash ? $hash : '';
		}

		$fp = @fopen( $file, 'rb' );
		if ( ! $fp ) {
			return '';
		}

		$ctx  = hash_init( 'md5' );
		$read = 0;

		while ( $read < $limit && ! feof( $fp ) ) {
			$chunk = fread( $fp, 262144 );
			if ( false === $chunk || '' === $chunk ) {
				break;
			}
			hash_update( $ctx, $chunk );
			$read += strlen( $chunk );
		}

		fclose( $fp );

		/* 帶上大小與標記，避免「前段相同、長度不同」被誤判為重複。 */
		return hash_final( $ctx ) . ':' . $size . ':prefix';
	}

	/**
	 * 清除全部雜湊（重建索引用）。
	 */
	public static function flush() {
		global $wpdb;
		$wpdb->delete( $wpdb->postmeta, array( 'meta_key' => self::META_HASH ), array( '%s' ) );
	}

	/**
	 * 重複群組總數（輕量查詢，不抓成員；供 Pro 的每週報告用）。
	 *
	 * @return int
	 */
	public static function count_groups() {
		global $wpdb;

		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM (
					SELECT m.meta_value
					   FROM {$wpdb->postmeta} m
					   JOIN {$wpdb->posts} p ON p.ID = m.post_id
					  WHERE m.meta_key = %s
					    AND CHAR_LENGTH( m.meta_value ) >= 8
					    AND p.post_type = 'attachment'
					    AND p.post_status IN ('inherit','private','publish')
					  GROUP BY m.meta_value
					 HAVING COUNT(*) > 1
				) t",
				self::META_HASH
			)
		);
	}

	/**
	 * 取得重複群組。
	 *
	 * @param int $max_groups 最多回傳幾組。
	 * @return array array( 'groups' => array( array( 'hash'=>, 'count'=>, 'items'=>array( item… ) ) ), 'group_count' => int, 'dupe_count' => int )
	 */
	public static function groups( $max_groups = self::MAX_GROUPS ) {
		global $wpdb;

		/* 成員數 > 1 的雜湊（排除空值與極短值）。 */
		$hashes = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT m.meta_value
				   FROM {$wpdb->postmeta} m
				   JOIN {$wpdb->posts} p ON p.ID = m.post_id
				  WHERE m.meta_key = %s
				    AND CHAR_LENGTH( m.meta_value ) >= 8
				    AND p.post_type = 'attachment'
				    AND p.post_status IN ('inherit','private','publish')
				  GROUP BY m.meta_value
				 HAVING COUNT(*) > 1
				  ORDER BY COUNT(*) DESC
				  LIMIT %d",
				self::META_HASH,
				$max_groups
			)
		);

		if ( empty( $hashes ) ) {
			return array(
				'groups'      => array(),
				'group_count' => 0,
				'dupe_count'  => 0,
				'truncated'   => false,
			);
		}

		/* 總群組數（供「還有更多」提示）。 */
		$total_groups = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM (
					SELECT m.meta_value
					   FROM {$wpdb->postmeta} m
					   JOIN {$wpdb->posts} p ON p.ID = m.post_id
					  WHERE m.meta_key = %s
					    AND CHAR_LENGTH( m.meta_value ) >= 8
					    AND p.post_type = 'attachment'
					    AND p.post_status IN ('inherit','private','publish')
					  GROUP BY m.meta_value
					 HAVING COUNT(*) > 1
				) t",
				self::META_HASH
			)
		);

		/* 一次把這些群組的所有成員撈出來。 */
		$placeholders = implode( ',', array_fill( 0, count( $hashes ), '%s' ) );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT p.ID, p.post_title, p.post_date, p.post_mime_type, m.meta_value AS hash
				   FROM {$wpdb->posts} p
				   JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = %s
				  WHERE m.meta_value IN ({$placeholders})
				    AND p.post_type = 'attachment'
				    AND p.post_status IN ('inherit','private','publish')
				  ORDER BY p.ID ASC",
				array_merge( array( self::META_HASH ), $hashes )
			),
			ARRAY_A
		);

		$by_hash = array();
		foreach ( (array) $rows as $row ) {
			$by_hash[ $row['hash'] ][] = $row;
		}

		$blocked = method_exists( 'PNMF_Taxonomy', 'restricted_media_ids' )
			? PNMF_Taxonomy::restricted_media_ids()
			: array();

		$groups     = array();
		$dupe_count = 0;

		foreach ( $hashes as $hash ) {
			if ( empty( $by_hash[ $hash ] ) ) {
				continue;
			}

			$items = array();
			foreach ( $by_hash[ $hash ] as $row ) {
				$id = (int) $row['ID'];

				$file     = (string) get_post_meta( $id, '_wp_attached_file', true );
				$filename = $file ? basename( $file ) : '';

				$size = (int) get_post_meta( $id, '_pnmf_filesize', true );
				if ( $size <= 0 ) {
					$path = get_attached_file( $id );
					$size = ( $path && file_exists( $path ) ) ? (int) wp_filesize( $path ) : 0;
				}

				$usage = get_post_meta( $id, PNMF_META_USAGE, true );
				$usage = ( '' === $usage || null === $usage ) ? '' : (string) intval( $usage );

				$thumb = '';
				if ( 0 === strpos( (string) $row['post_mime_type'], 'image/' ) ) {
					$icon  = wp_get_attachment_image_url( $id, 'thumbnail' );
					$thumb = $icon ? $icon : '';
				}

				$items[] = array(
					'id'       => $id,
					'title'    => (string) $row['post_title'],
					'filename' => $filename,
					'mime'     => (string) $row['post_mime_type'],
					'size'     => $size,
					'date'     => mysql2date( 'Y-m-d', $row['post_date'] ),
					'ts'       => (int) get_post_time( 'U', true, $id ), /* 供 Pro「保留最新」排序 */
					'usage'    => $usage, /* '' 未掃描 / '1' 使用中 / '0' 未使用 */
					'thumb'    => $thumb,
					'edit'     => admin_url( 'post.php?post=' . $id . '&action=edit' ),
					'blocked'  => in_array( $id, $blocked, true ),
				);
			}

			if ( count( $items ) < 2 ) {
				continue;
			}

			/* 群組內依 ID 排序（最舊在前），呈現穩定。 */
			usort(
				$items,
				static function ( $a, $b ) {
					return $a['id'] - $b['id'];
				}
			);

			$groups[]     = array(
				'hash'  => $hash,
				'count' => count( $items ),
				'items' => $items,
			);
			$dupe_count += count( $items ) - 1;
		}

		return array(
			'groups'      => $groups,
			'group_count' => count( $groups ),
			'dupe_count'  => $dupe_count,
			'truncated'   => $total_groups > count( $groups ),
		);
	}
}
