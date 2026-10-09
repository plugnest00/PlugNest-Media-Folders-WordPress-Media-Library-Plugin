<?php
/**
 * PlugNest Media Folders — 自動分類引擎。
 *
 * 依「檔名 / 副檔名 / 類型 / 尺寸 / 年份」等條件，把媒體自動歸入資料夾。
 *
 * 兩個安全設計：
 *   1. 一定要先「試跑預覽」——先看清楚會怎麼分，確認了才真的寫入。
 *   2. 規則可設「只處理尚未分類的媒體」，預設開啟，避免覆蓋手動整理好的結果。
 *
 * 整個過程只寫入分類關係（term_relationships），不碰任何檔案。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

class PNMF_Auto {

	/** 規則存放的 option key。 */
	const RULES_OPTION = 'pnmf_auto_rules';

	/** 工作狀態的 transient 前綴。 */
	const JOB_PREFIX = 'pnmf_job_';

	/** 每批處理筆數。 */
	const BATCH = 120;

	/**
	 * 預設規則（通用版）。
	 *
	 * 以 MIME 類型分流的四條入門規則：Videos / Audio / Pictures / Documents。
	 * 只在使用者按下「套用」時才會建立資料夾（平時不建、不動任何媒體）；
	 * 已分類的媒體預設不動（only_unassigned）。
	 *
	 * @return array
	 */
	public static function default_rules() {
		$rule = static function ( $id, $label, $group ) {
			return array(
				'id'              => $id,
				'label'           => $label,
				'enabled'         => true,
				'only_unassigned' => true,
				'match'           => array(
					'filename_contains' => '',
					'filename_regex'    => '',
					'ext_in'            => '',
					'mime_group'        => $group,
					'min_width'         => 0,
					'max_width'         => 0,
					'year'              => 0,
				),
				'target_folder'   => $label,
				'add_tags'        => array(),
			);
		};

		return array(
			$rule( 'r_videos', __( 'Videos', 'plugnest-media-folders' ), 'video' ),
			$rule( 'r_audio', __( 'Audio', 'plugnest-media-folders' ), 'audio' ),
			$rule( 'r_pictures', __( 'Pictures', 'plugnest-media-folders' ), 'image' ),
			$rule( 'r_documents', __( 'Documents', 'plugnest-media-folders' ), 'document' ),
		);
	}

	/**
	 * 讀取規則（未設定過則回傳預設）。
	 *
	 * @return array
	 */
	public static function get_rules() {
		$rules = get_option( self::RULES_OPTION );
		if ( ! is_array( $rules ) || empty( $rules ) ) {
			return self::default_rules();
		}
		return $rules;
	}

	/**
	 * 儲存規則。
	 *
	 * @param array $rules
	 * @return array 正規化後的規則。
	 */
	public static function save_rules( $rules ) {
		$clean = self::normalize_rules( $rules );
		update_option( self::RULES_OPTION, $clean, false );
		return $clean;
	}

	/**
	 * 正規化規則（清洗欄位、補 id），**不寫入**資料庫。
	 *
	 * 抽出來的理由：「試跑預覽」需要同一套清洗邏輯，但它不該改動已儲存的規則
	 * （先前 auto_preview 直接呼叫 save_rules，按一下 Dry run 就把規則存起來了）。
	 *
	 * @param array $rules
	 * @return array
	 */
	public static function normalize_rules( $rules ) {
		$clean = array();
		$i     = 0;

		foreach ( (array) $rules as $rule ) {
			if ( ! is_array( $rule ) ) {
				continue;
			}
			$i++;

			$match = isset( $rule['match'] ) && is_array( $rule['match'] ) ? $rule['match'] : array();

			$clean[] = array(
				'id'              => ! empty( $rule['id'] ) ? sanitize_key( $rule['id'] ) : ( 'r_' . $i . '_' . wp_generate_password( 4, false, false ) ),
				'label'           => sanitize_text_field( isset( $rule['label'] ) ? $rule['label'] : ( __( 'Rule', 'plugnest-media-folders' ) . ' ' . $i ) ),
				'enabled'         => ! empty( $rule['enabled'] ),
				'only_unassigned' => ! empty( $rule['only_unassigned'] ),
				'match'           => array(
					'filename_contains' => sanitize_text_field( isset( $match['filename_contains'] ) ? $match['filename_contains'] : '' ),
					'filename_regex'    => sanitize_text_field( isset( $match['filename_regex'] ) ? $match['filename_regex'] : '' ),
					'ext_in'            => sanitize_text_field( isset( $match['ext_in'] ) ? $match['ext_in'] : '' ),
					'mime_group'        => sanitize_text_field( isset( $match['mime_group'] ) ? $match['mime_group'] : '' ),
					'min_width'         => (int) ( isset( $match['min_width'] ) ? $match['min_width'] : 0 ),
					'max_width'         => (int) ( isset( $match['max_width'] ) ? $match['max_width'] : 0 ),
					'year'              => (int) ( isset( $match['year'] ) ? $match['year'] : 0 ),
				),
				'target_folder'   => sanitize_text_field( isset( $rule['target_folder'] ) ? $rule['target_folder'] : '' ),
				'add_tags'        => array_values( array_filter( array_map( 'sanitize_text_field', (array) ( isset( $rule['add_tags'] ) ? $rule['add_tags'] : array() ) ) ) ),
			);
		}

		return $clean;
	}

	/**
	 * 依路徑取得或建立資料夾，回傳 term_id。
	 *
	 * 例：'影音匯/ASMR' → 先確保「影音匯」存在，再確保其下的「ASMR」存在。
	 *
	 * @param string $path
	 * @return int
	 */
	public static function ensure_folder_path( $path ) {
		$parts = array_filter( array_map( 'trim', explode( '/', (string) $path ) ) );
		if ( empty( $parts ) ) {
			return 0;
		}

		$parent  = 0;
		$term_id = 0;

		foreach ( $parts as $name ) {
			$existing = term_exists( $name, PNMF_TAX_FOLDER, $parent );

			if ( $existing ) {
				$term_id = (int) ( is_array( $existing ) ? $existing['term_id'] : $existing );
			} else {
				$new = wp_insert_term( $name, PNMF_TAX_FOLDER, array( 'parent' => $parent ) );
				if ( is_wp_error( $new ) ) {
					return 0;
				}
				$term_id = (int) $new['term_id'];
			}

			$parent = $term_id;
		}

		return $term_id;
	}

	/**
	 * 列出所有資料夾的完整路徑（供規則設定介面使用）。
	 *
	 * @return array array( array( 'path' => '影音匯/ASMR', 'term_id' => 12, 'depth' => 1 ), … )
	 */
	public static function get_folder_paths() {
		$terms = get_terms(
			array(
				'taxonomy'   => PNMF_TAX_FOLDER,
				'hide_empty' => false,
			)
		);

		if ( is_wp_error( $terms ) || empty( $terms ) ) {
			return array();
		}

		$by_id = array();
		foreach ( $terms as $t ) {
			$by_id[ (int) $t->term_id ] = $t;
		}

		$out = array();
		foreach ( $terms as $t ) {
			$path  = array( $t->name );
			$guard = 0;
			$p     = (int) $t->parent;

			while ( $p > 0 && isset( $by_id[ $p ] ) && $guard < 20 ) {
				array_unshift( $path, $by_id[ $p ]->name );
				$p = (int) $by_id[ $p ]->parent;
				$guard++;
			}

			$out[] = array(
				'path'    => implode( '/', $path ),
				'term_id' => (int) $t->term_id,
				'depth'   => count( $path ) - 1,
			);
		}

		usort(
			$out,
			function ( $a, $b ) {
				return strcmp( $a['path'], $b['path'] );
			}
		);

		return $out;
	}

	/**
	 * 取出候選媒體的 ID 清單。
	 *
	 * 分批工作只需在開始時算一次，之後每批用 array_slice 取當前批次即可
	 * （見 step_job），不必每批重跑一次全量查詢。
	 *
	 * @param array $scope 範圍條件。
	 * @return int[]
	 */
	public static function candidate_ids( $scope ) {
		return PNMF_Query::get_ids( $scope );
	}

	/**
	 * 依 ID 清單補齊候選媒體的輕量資料（一次查詢，避免 N+1）。
	 *
	 * @param int[] $ids
	 * @return array array( array( 'id','filename','ext','mime','type','date','assigned' ), … )
	 */
	public static function hydrate_ids( $ids ) {
		global $wpdb;

		$ids = array_values( array_unique( array_map( 'intval', (array) $ids ) ) );
		if ( empty( $ids ) ) {
			return array();
		}

		$id_list   = implode( ',', $ids );
		$status_in = "'inherit','private','publish'";

		/* 一次撈出檔名、MIME、日期。 */
		$rows = $wpdb->get_results(
			"SELECT p.ID, p.post_mime_type, p.post_date, pm.meta_value AS file
			 FROM {$wpdb->posts} p
			 LEFT JOIN {$wpdb->postmeta} pm ON pm.post_id = p.ID AND pm.meta_key = '_wp_attached_file'
			 WHERE p.ID IN ({$id_list})
			   AND p.post_type = 'attachment'
			   AND p.post_status IN ({$status_in})",
			ARRAY_A
		);

		if ( ! $rows ) {
			return array();
		}

		/* 已指派的資料夾（用來判斷 only_unassigned）。 */
		$assigned = array();
		$rel_rows = $wpdb->get_results(
			"SELECT tr.object_id, tt.term_id
			 FROM {$wpdb->term_relationships} tr
			 INNER JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
			 WHERE tt.taxonomy = '" . esc_sql( PNMF_TAX_FOLDER ) . "'
			   AND tr.object_id IN ({$id_list})",
			ARRAY_A
		);
		if ( $rel_rows ) {
			foreach ( $rel_rows as $r ) {
				$assigned[ (int) $r['object_id'] ] = 1;
			}
		}

		$out = array();
		foreach ( $rows as $row ) {
			$id   = (int) $row['ID'];
			$file = (string) $row['file'];
			$mime = (string) $row['post_mime_type'];

			$out[] = array(
				'id'       => $id,
				'filename' => $file ? basename( $file ) : '',
				'ext'      => strtolower( pathinfo( $file, PATHINFO_EXTENSION ) ),
				'mime'     => $mime,
				'type'     => PNMF_Query::mime_group_of( $mime ),
				'date'     => (string) $row['post_date'],
				'assigned' => isset( $assigned[ $id ] ),
			);
		}

		return $out;
	}

	/**
	 * 取出候選媒體的輕量資料（ID + 明細，一次到位）。
	 *
	 * @param array $scope 範圍條件。
	 * @return array array( array( 'id','filename','ext','mime','type','date','assigned' ), … )
	 */
	public static function candidates( $scope ) {
		return self::hydrate_ids( self::candidate_ids( $scope ) );
	}

	/**
	 * 判斷單一規則是否命中。
	 *
	 * @param array $rule
	 * @param array $ctx 候選資料。
	 * @return bool
	 */
	public static function rule_matches( $rule, $ctx ) {
		$m = isset( $rule['match'] ) && is_array( $rule['match'] ) ? $rule['match'] : array();

		/* 檔名關鍵字（任一命中即可） */
		if ( ! empty( $m['filename_contains'] ) ) {
			$needles = array_filter( array_map( 'trim', explode( ',', $m['filename_contains'] ) ) );
			$hit     = false;
			foreach ( $needles as $needle ) {
				if ( self::stripos_utf8( $ctx['filename'], $needle ) !== false ) {
					$hit = true;
					break;
				}
			}
			if ( ! $hit ) {
				return false;
			}
		}

		/* 檔名正則 */
		if ( ! empty( $m['filename_regex'] ) ) {
			$pattern = '/' . str_replace( '/', '\/', $m['filename_regex'] ) . '/iu';
			$result  = @preg_match( $pattern, $ctx['filename'] ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
			if ( false === $result ) {
				// 正則無效 → 退化成子字串比對，避免整條規則默默失效。
				if ( self::stripos_utf8( $ctx['filename'], $m['filename_regex'] ) === false ) {
					return false;
				}
			} elseif ( 0 === $result ) {
				return false;
			}
		}

		/* 副檔名 */
		if ( ! empty( $m['ext_in'] ) ) {
			$exts = array_filter(
				array_map(
					function ( $e ) {
						return strtolower( trim( $e, " .\t\n\r" ) );
					},
					explode( ',', $m['ext_in'] )
				)
			);
			if ( ! in_array( $ctx['ext'], $exts, true ) ) {
				return false;
			}
		}

		/* 類型群組 */
		if ( ! empty( $m['mime_group'] ) ) {
			if ( $ctx['type'] !== $m['mime_group'] ) {
				return false;
			}
		}

		/* 年份 */
		if ( ! empty( $m['year'] ) ) {
			if ( (int) substr( $ctx['date'], 0, 4 ) !== (int) $m['year'] ) {
				return false;
			}
		}

		/* 寬度（需要時才載入 metadata） */
		if ( ! empty( $m['min_width'] ) || ! empty( $m['max_width'] ) ) {
			$meta   = wp_get_attachment_metadata( $ctx['id'] );
			$width  = isset( $meta['width'] ) ? (int) $meta['width'] : 0;
			if ( ! empty( $m['min_width'] ) && $width < (int) $m['min_width'] ) {
				return false;
			}
			if ( ! empty( $m['max_width'] ) && $width > (int) $m['max_width'] ) {
				return false;
			}
		}

		return true;
	}

	/**
	 * 找出第一個命中的規則。
	 *
	 * @param array $rules
	 * @param array $ctx
	 * @return array|null
	 */
	public static function first_match( $rules, $ctx ) {
		foreach ( $rules as $rule ) {
			if ( empty( $rule['enabled'] ) ) {
				continue;
			}
			if ( self::rule_matches( $rule, $ctx ) ) {
				return $rule;
			}
		}
		return null;
	}

	/**
	 * 試跑預覽：完全不寫入任何資料。
	 *
	 * @param array $rules
	 * @param array $scope
	 * @return array
	 */
	public static function preview( $rules, $scope ) {
		$candidates = self::candidates( $scope );

		$per_rule = array();
		foreach ( $rules as $rule ) {
			$per_rule[ $rule['id'] ] = array(
				'id'      => $rule['id'],
				'label'   => $rule['label'],
				'target'  => $rule['target_folder'],
				'count'   => 0,
				'skipped' => 0,
				'samples' => array(),
			);
		}

		$unmatched = 0;
		$skipped   = 0;

		foreach ( $candidates as $ctx ) {
			$rule = self::first_match( $rules, $ctx );

			if ( ! $rule ) {
				$unmatched++;
				continue;
			}

			/* 只處理未分類時，已分類的媒體會被跳過。 */
			if ( ! empty( $rule['only_unassigned'] ) && ! empty( $ctx['assigned'] ) ) {
				$per_rule[ $rule['id'] ]['skipped']++;
				$skipped++;
				continue;
			}

			$per_rule[ $rule['id'] ]['count']++;
			if ( count( $per_rule[ $rule['id'] ]['samples'] ) < 8 ) {
				$per_rule[ $rule['id'] ]['samples'][] = array(
					'id'       => $ctx['id'],
					'filename' => $ctx['filename'],
				);
			}
		}

		return array(
			'candidates' => count( $candidates ),
			'rules'      => array_values( $per_rule ),
			'unmatched'  => $unmatched,
			'skipped'    => $skipped,
			'will_apply' => max( 0, count( $candidates ) - $unmatched - $skipped ),
		);
	}

	/**
	 * 建立自動分類工作，並寫入一筆「進行中」的操作記錄。
	 *
	 * @param array $rules
	 * @param array $scope
	 * @return array|WP_Error
	 */
	public static function start_job( $rules, $scope ) {
		global $wpdb;

		/* 候選清單在這裡定案並存進 job：之後每一批只查當前批次的明細，
		 * 不再重跑全量查詢（原本 step_job 每批都重撈一次，是 O(n²)）。 */
		$ids = self::candidate_ids( $scope );
		if ( empty( $ids ) ) {
			return new WP_Error( 'no_candidates', __( 'No media in scope.', 'plugnest-media-folders' ) );
		}

		/* 先寫一筆空的記錄，之後每批把「本批新增的」明細 append 進去。 */
		$table = PNMF_Plugin::log_table();
		$wpdb->insert(
			$table,
			array(
				'created_at'   => current_time( 'mysql' ),
				'user_id'      => get_current_user_id(),
				'action'       => 'auto_classify',
				'object_count' => 0,
				'payload'      => wp_json_encode(
					array(
						'context'  => array( 'scope' => $scope ),
						'items'    => array(),
						'undoable' => true,
					)
				),
				'undone'       => 0,
			),
			array( '%s', '%d', '%s', '%d', '%s', '%d' )
		);

		$log_id = (int) $wpdb->insert_id;

		/* 注意：job 內「不再」累積 items。明細每批直接 append 進資料庫，
		 * transient 因此只存進度與統計，大小與媒體數無關（省記憶體、也避免
		 * 撞到 object cache 的單鍵大小上限）。 */
		$job = array(
			'log_id'     => $log_id,
			'offset'     => 0,
			'total'      => count( $ids ),
			'ids'        => array_values( array_map( 'intval', $ids ) ),
			'applied'    => 0,
			'skipped'    => 0,
			'unmatched'  => 0,
			'rules'      => $rules,
			'scope'      => $scope,
			'started_at' => time(),
		);

		set_transient( self::JOB_PREFIX . get_current_user_id(), $job, HOUR_IN_SECONDS );

		return array(
			'log_id' => $log_id,
			'total'  => $job['total'],
			'done'   => false,
		);
	}

	/**
	 * 執行一批。
	 *
	 * @return array|WP_Error
	 */
	public static function step_job() {
		global $wpdb;

		$key = self::JOB_PREFIX . get_current_user_id();
		$job = get_transient( $key );

		if ( ! is_array( $job ) ) {
			return new WP_Error( 'no_job', __( 'No auto-assign job is running.', 'plugnest-media-folders' ) );
		}

		/* 候選 ID 清單在 start_job() 就固定，之後每批只補當前批次的明細。
		 * （原本每批都重跑一次全量 candidates()，大站會愈跑愈慢。） */
		$ids = ( isset( $job['ids'] ) && is_array( $job['ids'] ) ) ? $job['ids'] : array();

		/* 相容舊版 job（只存了 scope、沒有 ids）：就地重建一次。 */
		if ( empty( $ids ) && ! empty( $job['scope'] ) ) {
			$ids = self::candidate_ids( $job['scope'] );
		}

		/* 用 offset 從 ID 清單切片，再補這一小批的明細。 */
		$slice_ids = array_slice( $ids, (int) $job['offset'], self::BATCH );

		if ( empty( $slice_ids ) ) {
			return self::finish_job( $job, $key );
		}

		$slice = self::hydrate_ids( $slice_ids );

		$rules = $job['rules'];

		/* 先把每條規則的目標資料夾準備好（同一規則只建立一次）。 */
		$folder_cache = array();
		$tag_cache    = array();

		/* 本批新增的明細（只 append 這些，不重寫整份 payload）。 */
		$batch_items = array();

		foreach ( $slice as $ctx ) {
			$rule = self::first_match( $rules, $ctx );

			if ( ! $rule ) {
				$job['unmatched']++;
				continue;
			}

			if ( ! empty( $rule['only_unassigned'] ) && ! empty( $ctx['assigned'] ) ) {
				$job['skipped']++;
				continue;
			}

			$target = (string) $rule['target_folder'];
			if ( '' === $target ) {
				$job['unmatched']++;
				continue;
			}

			if ( ! isset( $folder_cache[ $target ] ) ) {
				$folder_cache[ $target ] = self::ensure_folder_path( $target );
			}
			$folder_id = $folder_cache[ $target ];

			if ( $folder_id <= 0 ) {
				$job['unmatched']++;
				continue;
			}

			/* 快照：還原用。 */
			$before_terms = array_map( 'intval', (array) wp_get_object_terms( $ctx['id'], PNMF_TAX_FOLDER, array( 'fields' => 'ids' ) ) );
			$before_tags  = array_map( 'intval', (array) wp_get_object_terms( $ctx['id'], PNMF_TAX_TAG, array( 'fields' => 'ids' ) ) );

			/* 指派資料夾（附加，不移除既有——避免破壞手動分類）。 */
			wp_set_object_terms( $ctx['id'], array( $folder_id ), PNMF_TAX_FOLDER, true );

			/* 附加標籤。 */
			$tags = isset( $rule['add_tags'] ) ? (array) $rule['add_tags'] : array();
			if ( $tags ) {
				wp_set_object_terms( $ctx['id'], $tags, PNMF_TAX_TAG, true );
			}

			$batch_items[] = array(
				'id'     => $ctx['id'],
				'before' => array(
					'terms' => array(
						PNMF_TAX_FOLDER => $before_terms,
						PNMF_TAX_TAG    => $before_tags,
					),
				),
				'after'  => array(
					'terms' => array(
						PNMF_TAX_FOLDER => array( $folder_id ),
					),
				),
			);

			$job['applied']++;
		}

		/* 以「切片長度」推進（不是 $slice 長度）：若期間有媒體被刪除，
		 * hydrate 會少幾筆，用 $slice 推進會卡住同一段而無限迴圈。 */
		$job['offset'] = (int) $job['offset'] + count( $slice_ids );

		/* 只把本批新增的明細 append 進去（增量，不重寫整份）。 */
		self::persist_items( $job['log_id'], $batch_items );

		set_transient( $key, $job, HOUR_IN_SECONDS );

		$done = $job['offset'] >= $job['total'];

		if ( $done ) {
			return self::finish_job( $job, $key );
		}

		return array(
			'log_id'    => $job['log_id'],
			'total'     => $job['total'],
			'processed' => $job['offset'],
			'applied'   => $job['applied'],
			'skipped'   => $job['skipped'],
			'unmatched' => $job['unmatched'],
			'done'      => false,
		);
	}

	/**
	 * 收尾。
	 *
	 * @param array  $job
	 * @param string $key
	 * @return array
	 */
	private static function finish_job( $job, $key ) {
		/* 明細已在每批就地 append 進記錄，這裡不再重寫（不重寫就不會覆蓋掉
		 * 已寫入的內容，也省下一次大型 UPDATE）。 */
		delete_transient( $key );

		return array(
			'log_id'    => $job['log_id'],
			'total'     => $job['total'],
			'processed' => $job['offset'],
			'applied'   => $job['applied'],
			'skipped'   => $job['skipped'],
			'unmatched' => $job['unmatched'],
			'done'      => true,
		);
	}

	/**
	 * 把「這一批新增的明細」append 進操作記錄。
	 *
	 * 為什麼是增量而不是整份重寫：
	 *   原本每批都把記憶體中「累積到現在的全部 items」重新 json_encode 後
	 *   覆寫整份 payload。跑 n 批就是 O(n²) 的編碼／寫入量，而且記憶體中的
	 *   items 陣列會一直長大（大站會撞到記憶體與 transient 大小上限）。
	 *   改成只 append 本批新增的幾筆後，每批的工作量固定，總量是 O(n)。
	 *
	 * ⚠️ 上限：與 PNMF_Log::MAX_ITEMS 一致。超過上限後不再累積明細
	 *     （只保留統計），並把 undoable 設為 false——否則這個路徑會是
	 *    「唯一不受上限保護」的漏洞（它不走 PNMF_Log::add()）。
	 *
	 * @param int   $log_id
	 * @param array $new_items 只含本批新增的明細。
	 * @return int 寫入後記錄內的明細總數。
	 */
	private static function persist_items( $log_id, $new_items ) {
		global $wpdb;

		$log_id = (int) $log_id;
		if ( $log_id <= 0 ) {
			return 0;
		}

		$table = PNMF_Plugin::log_table();

		$row = $wpdb->get_row(
			$wpdb->prepare( "SELECT payload, object_count FROM {$table} WHERE id = %d", $log_id ),
			ARRAY_A
		);

		$data = $row ? json_decode( (string) $row['payload'], true ) : array();
		if ( ! is_array( $data ) ) {
			$data = array();
		}

		$existing = ( isset( $data['items'] ) && is_array( $data['items'] ) ) ? $data['items'] : array();
		$limit    = PNMF_Log::MAX_ITEMS;
		$truncated = ! empty( $data['truncated'] );

		$merged = $existing;
		if ( ! $truncated ) {
			foreach ( (array) $new_items as $item ) {
				if ( count( $merged ) >= $limit ) {
					/* 到頂了：後續不再存明細，只記統計。 */
					$truncated = true;
					$merged    = array();
					break;
				}
				$merged[] = $item;
			}
		}

		$data['items']     = $merged;
		$data['undoable']  = ! $truncated;
		$data['truncated'] = $truncated;

		$wpdb->update(
			$table,
			array(
				'payload'      => wp_json_encode( $data ),
				'object_count' => (int) ( $row['object_count'] ?? 0 ) + count( (array) $new_items ),
			),
			array( 'id' => $log_id ),
			array( '%s', '%d' ),
			array( '%d' )
		);

		return count( $data['items'] );
	}

	/**
	 * 取消進行中的工作。
	 *
	 * @return bool
	 */
	public static function cancel_job() {
		$key = self::JOB_PREFIX . get_current_user_id();
		$job = get_transient( $key );
		if ( is_array( $job ) ) {
			/* 明細已在每批就地 append，取消時不需要（也不應該）重寫。 */
			delete_transient( $key );
			return true;
		}
		return false;
	}

	/**
	 * UTF-8 友善的不分大小寫搜尋。
	 *
	 * @param string $haystack
	 * @param string $needle
	 * @return int|false
	 */
	private static function stripos_utf8( $haystack, $needle ) {
		if ( '' === $needle ) {
			return false;
		}
		if ( function_exists( 'mb_stripos' ) ) {
			return mb_stripos( $haystack, $needle, 0, 'UTF-8' );
		}
		return stripos( $haystack, $needle );
	}
}
